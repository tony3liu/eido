//! Explicit ACP resources and user-directed file actions. Never infer output paths
//! from tool locations, which commonly describe inputs.
use std::{path::{Path, PathBuf}, sync::Arc};
use anyhow::{Result, anyhow};
use base64::Engine as _;
use acp_thread::ContentBlock;
use agent_client_protocol::schema::v1 as acp;

#[derive(Clone)]
pub(crate) enum Source {
    Bytes(Arc<[u8]>),
    File(PathBuf),
    Link(String),
}

#[derive(Clone)]
pub(crate) struct ResultAsset {
    pub name: String,
    pub kind: String,
    pub location: Option<String>,
    pub source: Source,
    pub preview: Option<Arc<gpui::Image>>,
}

pub(crate) fn local_path(uri: &str) -> Option<PathBuf> {
    let mut url = url::Url::parse(uri).ok()?;
    if url.scheme() != "file" { return None; }
    url.set_fragment(None);
    url.set_query(None);
    url.to_file_path().ok().filter(|path| path.is_absolute())
}

/// Accept only the narrow standalone format emitted by the MCP bridge/image
/// tool. Complex Markdown stays with the Markdown renderer without losing text.
fn standalone_file_link(source: &str) -> Option<(&str, &str, bool)> {
    let saved_image = source.starts_with("Saved image: ");
    let link = source.strip_prefix("Saved image: ").unwrap_or(source);
    let (name, uri) = link.strip_prefix('[')?.strip_suffix(')')?.split_once("](")?;
    if name.is_empty() || name.chars().any(|ch| matches!(ch, '[' | ']' | '\n' | '\r' | '`'))
        || uri.chars().any(|ch| ch.is_whitespace() || matches!(ch, '[' | ']' | '`' | '<' | '>'))
    { return None; }
    let mut nesting = 0usize;
    for ch in uri.chars() {
        match ch {
            '(' => nesting += 1,
            ')' => nesting = nesting.checked_sub(1)?,
            _ => {}
        }
    }
    if nesting != 0 { return None; }
    local_path(uri)?;
    Some((name, uri, saved_image))
}

impl ResultAsset {
    fn linked(uri: &str, name: Option<&str>, kind: Option<&str>) -> Self {
        let path = local_path(uri);
        let name = name.filter(|name| !name.trim().is_empty()).map(str::to_string)
            .or_else(|| path.as_ref()?.file_name().map(|name| name.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "Resource".into());
        Self { name, kind: kind.unwrap_or("File").to_string(), location: Some(uri.to_string()),
            source: path.map(Source::File).unwrap_or_else(|| Source::Link(uri.to_string())), preview: None }
    }

    pub fn from_content(content: &ContentBlock, cx: &gpui::App) -> Option<Self> {
        if let ContentBlock::Markdown { markdown } = content {
            let source = markdown.read(cx).source().trim();
            let (name, uri, saved_image) = standalone_file_link(source)?;
            return Some(Self::linked(uri, if saved_image { None } else { Some(name) }, None));
        }
        if let Some((image, _)) = content.image() {
            return Some(Self { name: format!("image.{}", image.format().extension()),
                kind: image.format().mime_type().into(), location: None,
                source: Source::Bytes(image.bytes().into()), preview: Some(image.clone()) });
        }
        if let Some(link) = content.resource_link() {
            if link.uri.starts_with("eido-source:") { return None; }
            return Some(Self::linked(&link.uri, link.title.as_deref().or(Some(&link.name)), link.mime_type.as_deref()));
        }
        if let Some((resource, _)) = content.embedded_resource() {
            return match &resource.resource {
                acp::EmbeddedResourceResource::BlobResourceContents(blob) => {
                    let mut asset = Self::linked(&blob.uri, None, blob.mime_type.as_deref());
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&blob.blob) {
                        asset.source = Source::Bytes(bytes.into());
                    }
                    Some(asset)
                }
                // Keep text/Markdown embedded resources in the existing renderer;
                // replacing them with a file card would discard the embedded text.
                acp::EmbeddedResourceResource::TextResourceContents(_) => None,
                _ => None,
            };
        }
        None
    }

    pub fn can_save(&self) -> bool { !matches!(self.source, Source::Link(_)) }

    pub fn bytes(&self) -> Result<Vec<u8>> {
        match &self.source {
            Source::Bytes(bytes) => Ok(bytes.to_vec()),
            Source::File(path) => Ok(std::fs::read(path)?),
            Source::Link(_) => Err(anyhow!("This resource has no local file content")),
        }
    }

    pub fn save(&self, destination: Option<&Path>) -> Result<bool> {
        let Some(destination) = destination else { return Ok(false); };
        let bytes = self.bytes()?;
        std::fs::write(destination, bytes)?;
        Ok(true)
    }

    pub fn open_uri(&self, temporary: &TemporaryResults, key: &str) -> Result<String> {
        match &self.source {
            Source::Link(uri) => {
                let url = url::Url::parse(uri)?;
                if !matches!(url.scheme(), "http" | "https") { return Err(anyhow!("Unsupported resource location")); }
                Ok(uri.clone())
            }
            Source::File(path) => {
                let _file = std::fs::File::open(path)?;
                if !path.is_file() { return Err(anyhow!("Resource is not a file")); }
                Ok(url::Url::from_file_path(path).map_err(|_| anyhow!("Invalid file path"))?.into())
            }
            Source::Bytes(bytes) => {
                std::fs::create_dir_all(&temporary.0)?;
                let extension = self.preview.as_ref().map(|image| image.format().extension())
                    .or_else(|| Path::new(&self.name).extension().and_then(|ext| ext.to_str())).unwrap_or("bin");
                // The caller provides an internal entry/content id, never a remote filename.
                let path = temporary.0.join(format!("{key}.{extension}"));
                std::fs::write(&path, bytes)?;
                Ok(url::Url::from_file_path(path).map_err(|_| anyhow!("Invalid file path"))?.into())
            }
        }
    }
}

pub(crate) struct TemporaryResults(PathBuf);
impl Default for TemporaryResults {
    fn default() -> Self { Self(std::env::temp_dir().join(format!("eido-results-{}", uuid::Uuid::new_v4()))) }
}
impl Drop for TemporaryResults {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

#[derive(Clone, Default)]
pub(crate) enum ActionState { #[default] Idle, Busy, Saved, Failed(String) }

#[test]
fn test_eido_workbench_refresh_result_actions() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("研究 100%.pdf");
    std::fs::write(&source, b"%PDF-fixture").unwrap();
    let uri = format!("{}#page=1", url::Url::from_file_path(&source).unwrap());
    assert_eq!(local_path(&uri), Some(source.clone()));
    assert_eq!(local_path("https://example.com/file.pdf"), None);
    assert_eq!(local_path("file://remote.example/file.pdf"), None);
    let asset = ResultAsset::linked(&uri, None, Some("application/pdf"));
    assert_eq!(asset.name, "研究 100%.pdf");
    let temporary = TemporaryResults::default();
    assert_eq!(local_path(&asset.open_uri(&temporary, "0-0").unwrap()), Some(source.clone()));
    assert!(!asset.save(None).unwrap(), "canceling is not a successful save");
    let copy = directory.path().join("副本.pdf");
    assert!(asset.save(Some(&copy)).unwrap());
    assert_eq!(std::fs::read(copy).unwrap(), b"%PDF-fixture");
    std::fs::remove_file(source).unwrap();
    assert!(asset.open_uri(&temporary, "0-0").is_err());
    assert!(asset.save(Some(&directory.path().join("missing.pdf"))).is_err());
    assert!(!directory.path().join("missing.pdf").exists());
    let image = ResultAsset { name: "image.png".into(), kind: "image/png".into(), location: None,
        source: Source::Bytes(Arc::from(&b"original image bytes"[..])), preview: None };
    let image_uri = image.open_uri(&temporary, "1-0").unwrap();
    let image_path = local_path(&image_uri).unwrap();
    assert_eq!(std::fs::read(&image_path).unwrap(), b"original image bytes");
    drop(temporary);
    assert!(!image_path.exists(), "temporary previews are owned by the conversation");
}

#[gpui::test]
fn test_eido_workbench_refresh_repair_markdown_preserves_mixed_content(cx: &mut gpui::TestAppContext) {
    use gpui::AppContext as _;
    cx.update(|cx| {
        for (source, expected) in [
            ("[报告](file:///tmp/%E6%8A%A5%E5%91%8A%20100%25.pdf)", Some("报告")),
            ("Saved image: [/tmp/preview.png](file:///tmp/preview.png)", Some("preview.png")),
            ("[report](file:///tmp/report(1).pdf)", Some("report")),
            ("[source](https://example.com)\n\nImportant ordinary text\n\n[file](file:///tmp/report.pdf)", None),
            ("[first](file:///tmp/one.pdf)[second](file:///tmp/two.pdf)", None),
            ("[first](file:///tmp/one.pdf) ordinary text [second](file:///tmp/two.pdf)", None),
            ("[label\nparagraph](file:///tmp/report.pdf)", None),
            ("`[file](file:///tmp/report.pdf)`", None),
            ("[file](file:///tmp/report.pdf)\n```text\n[file](file:///tmp/other.pdf)\n```", None),
            ("Saved image: [one](file:///tmp/one.png) plus [two](file:///tmp/two.png)", None),
            ("Saved image: [one](file:///tmp/one.png)\n\nDo not discard this paragraph.", None),
            ("[file](file:///tmp/report.pdf) trailing text", None),
            ("[file](file:///tmp/report.pdf \"title\")", None),
            ("[file](https://example.com/report.pdf)", None),
        ] {
            let markdown = cx.new(|cx| markdown::Markdown::new(source.into(), None, None, cx));
            let block = ContentBlock::Markdown { markdown: markdown.clone() };
            let asset = ResultAsset::from_content(&block, cx);
            assert_eq!(asset.as_ref().map(|asset| asset.name.as_str()), expected, "source: {source}");
            assert_eq!(markdown.read(cx).source(), source, "fallback content stays intact");
        }
    });
}
