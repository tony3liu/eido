use gpui::AppContext;
use anyhow::{Context as _, Result, anyhow, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, VecDeque}, io::{Cursor, Read}, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use uuid::Uuid;

pub const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 256 * 1024;
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
pub const RENDER_VERSION: &str = "eido-canonical-1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentDescriptor {
    pub version: u32,
    pub attachment_id: String,
    pub original_name: String,
    pub mime_type: String,
    pub size: usize,
    pub expected_hash: String,
    pub selection_identity: String,
    // Native-only ownership. Serialized descriptors remain identifiers, not file authority.
    #[serde(skip)]
    pub(crate) lease: Arc<()>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageManifest {
    pub page_index: usize,
    pub page_count: usize,
    pub original_size: [f64; 2],
    pub crop_box: [f64; 4],
    pub rotation: i32,
    pub render_width: u32,
    pub render_height: u32,
    pub transform: [f64; 6],
    pub render_version: String,
    pub png_hash: String,
    pub first_frame_only: bool,
}
#[derive(Clone)]
pub struct RenderedPage { pub manifest: PageManifest, pub png: Arc<Vec<u8>> }
struct Selection { descriptor: DocumentDescriptor, path: PathBuf, bindings: Vec<(String, String)> }
struct Capture { session: String, turn: String, identity: String, hash: String, bytes: Arc<Vec<u8>>, expires: Instant }
#[derive(Default)]
pub struct DocumentRegistry {
    selections: HashMap<String, Selection>,
    captures: HashMap<String, Capture>,
    cache: VecDeque<(String, RenderedPage)>,
}
pub fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    let metadata = std::fs::metadata(path)?;
    ensure!(metadata.is_file() && metadata.len() > 0 && metadata.len() <= MAX_FILE_BYTES as u64, "Select a non-empty file of at most 20 MiB.");
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take((MAX_FILE_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_FILE_BYTES, "The selected file exceeds 20 MiB.");
    Ok(bytes)
}
fn mime(bytes: &[u8]) -> Result<&'static str> {
    if bytes.starts_with(b"%PDF-") { return Ok("application/pdf"); }
    Ok(match image::guess_format(bytes)? {
        ImageFormat::Png => "image/png", ImageFormat::Jpeg => "image/jpeg", ImageFormat::WebP => "image/webp",
        ImageFormat::Bmp => "image/bmp", ImageFormat::Gif => "image/gif", _ => bail!("Select a PDF, PNG, JPEG, WebP, BMP or GIF file."),
    })
}
impl DocumentRegistry {
    /// Called only from a native file picker, drop or explicit file mention.
    pub fn select(&mut self, path: &Path) -> Result<DocumentDescriptor> {
        self.prune();
        ensure!(self.selections.len() < 128, "Too many selected documents. Remove unused attachments first.");
        let path = path.canonicalize()?;
        let bytes = read_bounded(&path)?;
        let descriptor = DocumentDescriptor { version: 1, attachment_id: Uuid::new_v4().to_string(),
            original_name: path.file_name().context("The selected file has no name.")?.to_string_lossy().into_owned(),
            mime_type: mime(&bytes)?.into(), size: bytes.len(), expected_hash: hash(&bytes), selection_identity: Uuid::new_v4().to_string(), lease: Arc::new(()) };
        self.selections.insert(descriptor.attachment_id.clone(), Selection {descriptor: descriptor.clone(), path, bindings: Vec::new()});
        Ok(descriptor)
    }
    pub fn descriptor(&self,id:&str)->Result<DocumentDescriptor>{Ok(self.selections.get(id).context("Select the document again.")?.descriptor.clone())}
    pub fn preview(&self,descriptor:&DocumentDescriptor,index:usize)->Result<RenderedPage>{
        let selected=self.selections.get(&descriptor.attachment_id).context("Select the document again.")?;
        ensure!(&selected.descriptor==descriptor,"Attachment identity changed.");let bytes=read_bounded(&selected.path)?;ensure!(hash(&bytes)==descriptor.expected_hash,"File changed · New version required");render(&bytes,index)
    }
    pub fn bind(&mut self, descriptor: &DocumentDescriptor, session: &str, turn: &str) -> Result<()> {
        ensure!(!session.is_empty() && !turn.is_empty(), "A document must be submitted to a task and turn.");
        let selection = self.selections.get_mut(&descriptor.attachment_id).context("Attachment must be selected again.")?;
        ensure!(&selection.descriptor == descriptor, "Attachment identity changed.");
        ensure!(hash(&read_bounded(&selection.path)?) == descriptor.expected_hash, "File changed · New version required");
        let binding = (session.to_owned(), turn.to_owned());
        if !selection.bindings.contains(&binding) { selection.bindings.push(binding); }
        Ok(())
    }
    fn prune(&mut self) {
        self.captures.retain(|_, capture| capture.expires > Instant::now());
        self.selections.retain(|_, selection| Arc::strong_count(&selection.descriptor.lease)>1 || !selection.bindings.is_empty());
    }
    pub fn retain_descriptor(&self, descriptor:&DocumentDescriptor)->Result<DocumentDescriptor> {
        let selected=self.selections.get(&descriptor.attachment_id).context("Select the document again.")?;
        ensure!(&selected.descriptor==descriptor,"Attachment identity changed.");
        Ok(selected.descriptor.clone())
    }
    fn capture(&mut self, session: &str, turn: &str, identity: &str, bytes: Arc<Vec<u8>>) -> Result<String> {
        self.prune();
        ensure!(self.captures.values().map(|capture| capture.bytes.len()).sum::<usize>() + bytes.len() <= MAX_CACHE_BYTES, "Document capture memory limit reached. Release earlier pages first.");
        let handle = Uuid::new_v4().to_string();
        self.captures.insert(handle.clone(), Capture {session:session.into(),turn:turn.into(),identity:identity.into(),hash:hash(&bytes),bytes,expires:Instant::now()+Duration::from_secs(300)});
        Ok(handle)
    }
    pub fn request(&mut self, request: Value) -> Result<Value> {
        self.prune();
        ensure!(request["version"] == 1, "Unsupported document protocol version.");
        let session=request["sessionId"].as_str().context("Document task identity is required.")?;
        if request["action"]=="release_session" {self.release_session(session);return Ok(json!({"released":true}));}
        let turn=request["turnId"].as_str().context("Document turn identity is required.")?;
        if request["action"]=="bind" {let descriptor:DocumentDescriptor=serde_json::from_value(request["descriptor"].clone())?;self.bind(&descriptor,session,turn)?;return Ok(json!({"bound":true}));}
        if request["action"]=="release_turn" {self.release_turn(session,turn);return Ok(json!({"released":true}));}
        let identity=request["selectionIdentity"].as_str().context("Document selection identity is required.")?;
        match request["action"].as_str().unwrap_or_default() {
            "open" => {
                let selection=self.selections.get(request["attachmentId"].as_str().unwrap_or_default()).context("Attachment is unavailable.")?;
                ensure!(selection.descriptor.selection_identity==identity && selection.bindings.contains(&(session.into(),turn.into())), "Attachment is not authorized for this task and turn.");
                let bytes=Arc::new(read_bounded(&selection.path)?);
                ensure!(hash(&bytes)==selection.descriptor.expected_hash && bytes.len()==selection.descriptor.size, "File changed · New version required");
                let descriptor=selection.descriptor.clone();
                let handle=self.capture(session,turn,identity,bytes)?;
                Ok(json!({"version":1,"handle":handle,"descriptor":descriptor,"chunkBytes":CHUNK_BYTES}))
            }
            "chunk" | "release" | "render" => {
                let handle=request["handle"].as_str().context("Document capture handle is required.")?;
                let capture=self.captures.get(handle).context("Document capture expired or was released.")?;
                ensure!(capture.session==session && capture.turn==turn && capture.identity==identity && request["expectedHash"]==capture.hash, "Document capture identity mismatch.");
                match request["action"].as_str().unwrap() {
                    "chunk" => {
                        let offset=request["offset"].as_u64().context("Document chunk offset is required.")? as usize;
                        ensure!(offset<=capture.bytes.len() && offset%CHUNK_BYTES==0, "Invalid document chunk offset.");
                        let end=(offset+CHUNK_BYTES).min(capture.bytes.len());
                        Ok(json!({"version":1,"offset":offset,"total":capture.bytes.len(),"hash":capture.hash,"content":STANDARD.encode(&capture.bytes[offset..end]),"next":if end<capture.bytes.len(){Some(end)}else{None}}))
                    }
                    "release" => { self.captures.remove(handle); Ok(json!({"released":true})) }
                    "render" => {
                        let page_index=request["pageIndex"].as_u64().context("Document page index is required.")? as usize;
                        let key=format!("{}:{page_index}:{RENDER_VERSION}",capture.hash);
                        let page=if let Some((_,page))=self.cache.iter().find(|(old,_)| old==&key) {page.clone()} else {
                            let page=render(&capture.bytes,page_index)?;
                            while self.cache.iter().map(|(_,page)|page.png.len()).sum::<usize>()+page.png.len()>MAX_CACHE_BYTES { self.cache.pop_front(); }
                            self.cache.push_back((key,page.clone())); page
                        };
                        let page_handle=self.capture(session,turn,identity,page.png.clone())?;
                        Ok(json!({"version":1,"handle":page_handle,"size":page.png.len(),"manifest":page.manifest,"chunkBytes":CHUNK_BYTES}))
                    }
                    _ => unreachable!(),
                }
            }
            _ => bail!("Unsupported document action."),
        }
    }
    pub fn release_session(&mut self, session:&str) {
        self.captures.retain(|_,capture|capture.session!=session);
        for selection in self.selections.values_mut(){selection.bindings.retain(|binding|binding.0!=session);}
        self.cache.clear();self.prune();
    }
    pub fn release_turn(&mut self, session: &str, turn: &str) {
        self.captures.retain(|_,capture|capture.session!=session || capture.turn!=turn);
        self.cache.clear();
        for selection in self.selections.values_mut(){selection.bindings.retain(|binding|binding!=&(session.into(),turn.into()));}
        self.prune();
    }
}
#[derive(Clone)]
pub struct NativeDocuments(pub Arc<Mutex<DocumentRegistry>>);
impl gpui::Global for NativeDocuments {}
pub fn init(cx: &mut gpui::App) {
    let registry=Arc::new(Mutex::new(DocumentRegistry::default()));
    cx.set_global(NativeDocuments(registry.clone()));
    cx.set_global(acp_thread::EidoDocumentHost(Arc::new(move |request| registry.lock().map_err(|_|anyhow!("Document registry unavailable."))?.request(request))));
}
fn dimensions(width: f64, height: f64, pdf: bool) -> Result<(u32,u32)> {
    ensure!(width.is_finite() && height.is_finite() && width>0.0 && height>0.0 && width<1e7 && height<1e7, "Invalid document page dimensions.");
    let scale=(if pdf {200.0/72.0} else {1.0_f64}).min(4096.0/width.max(height));
    let (w,h)=((width*scale).round().max(1.0) as u32,(height*scale).round().max(1.0) as u32);
    ensure!((w as u64)*(h as u64)<=16_000_000, "Document page exceeds 16 million pixels.");
    Ok((w,h))
}
fn encode(image: DynamicImage, mut manifest: PageManifest) -> Result<RenderedPage> {
    let mut output=Cursor::new(Vec::new()); image.write_to(&mut output,ImageFormat::Png)?;
    let png=output.into_inner(); ensure!(png.len()<=MAX_FILE_BYTES,"Rendered page exceeds 20 MiB.");
    manifest.png_hash=hash(&png); Ok(RenderedPage{manifest,png:Arc::new(png)})
}
pub fn render(bytes: &[u8], page_index: usize) -> Result<RenderedPage> {
    ensure!(!bytes.is_empty() && bytes.len()<=MAX_FILE_BYTES,"Document exceeds 20 MiB.");
    if mime(bytes)?=="application/pdf" { return render_pdf(bytes,page_index); }
    ensure!(page_index==0,"An image has only one static page.");
    let mut reader=ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits=image::Limits::default(); limits.max_alloc=Some(MAX_CACHE_BYTES as u64); reader.limits(limits);
    let mut decoder=reader.into_decoder()?;
    let orientation=decoder.orientation()?;
    let mut image=DynamicImage::from_decoder(decoder)?; image.apply_orientation(orientation);
    let original_size=[image.width() as f64,image.height() as f64];
    let (width,height)=dimensions(original_size[0],original_size[1],false)?;
    if image.width()!=width || image.height()!=height { image=image.resize_exact(width,height,image::imageops::FilterType::Lanczos3); }
    encode(image,PageManifest{page_index:0,page_count:1,original_size,crop_box:[0.0,0.0,original_size[0],original_size[1]],rotation:0,
        render_width:width,render_height:height,transform:[width as f64/original_size[0],0.0,0.0,height as f64/original_size[1],0.0,0.0],render_version:RENDER_VERSION.into(),png_hash:String::new(),first_frame_only:mime(bytes)?=="image/gif"})
}
#[cfg(not(target_os="macos"))]
fn render_pdf(_bytes:&[u8],_page_index:usize)->Result<RenderedPage>{bail!("Native PDF rendering is supported on macOS only.")}
#[cfg(target_os="macos")]
fn render_pdf(bytes:&[u8],page_index:usize)->Result<RenderedPage>{
    use objc2_core_graphics::*;
    use objc2_core_foundation::{CGRect, CGPoint, CGSize};
    // The provider and document are dropped before the borrowed source byte slice.
    let provider=unsafe {CGDataProvider::with_data(std::ptr::null_mut(),bytes.as_ptr().cast(),bytes.len(),None)}.context("Unable to read PDF bytes.")?;
    let document=CGPDFDocument::with_provider(Some(&provider)).context("The PDF is damaged or unsupported.")?;
    ensure!(!CGPDFDocument::is_encrypted(Some(&document)),"Encrypted PDFs are not supported.");
    let count=CGPDFDocument::number_of_pages(Some(&document));
    ensure!(count>0 && count<=50,"PDF must contain 1–50 pages."); ensure!(page_index<count,"PDF page is unavailable.");
    // Reject malformed or oversized pages before the first page can be uploaded.
    for index in 1..=count {
        let page=CGPDFDocument::page(Some(&document),index).context("PDF page is unavailable.")?;
        let crop=CGPDFPage::box_rect(Some(&page),CGPDFBox::CropBox);
        let rotated=CGPDFPage::rotation_angle(Some(&page)).rem_euclid(180)==90;
        dimensions(if rotated{crop.size.height}else{crop.size.width},if rotated{crop.size.width}else{crop.size.height},true)?;
    }
    let page=CGPDFDocument::page(Some(&document),page_index+1).context("PDF page is unavailable.")?;
    let crop=CGPDFPage::box_rect(Some(&page),CGPDFBox::CropBox);
    let rotation=CGPDFPage::rotation_angle(Some(&page));
    let original_size=[crop.size.width,crop.size.height];
    let swapped=rotation.rem_euclid(180)==90;
    let (width,height)=dimensions(if swapped{original_size[1]}else{original_size[0]},if swapped{original_size[0]}else{original_size[1]},true)?;
    let mut rgba=vec![255u8;width as usize*height as usize*4];
    let colors=CGColorSpace::new_device_rgb().context("PDF color space unavailable.")?;
    // Premultiplied-last, 32-bit big-endian is RGBA in memory. Opaque white avoids alpha ambiguity.
    let context=unsafe {CGBitmapContextCreate(rgba.as_mut_ptr().cast(),width as usize,height as usize,8,width as usize*4,Some(&colors),0x4001)}.context("Unable to allocate PDF page raster.")?;
    let rect=CGRect::new(CGPoint::new(0.0,0.0),CGSize::new(width as f64,height as f64));
    CGContext::set_rgb_fill_color(Some(&context),1.0,1.0,1.0,1.0); CGContext::fill_rect(Some(&context),rect);
    let transform=CGPDFPage::drawing_transform(Some(&page),CGPDFBox::CropBox,rect,0,true);
    CGContext::concat_ctm(Some(&context),transform); CGContext::draw_pdf_page(Some(&context),Some(&page));
    drop(context);
    // CoreGraphics bitmap rows use the image's top-to-bottom storage convention. The manifest
    // records PDF coordinates mapped into a top-left pixel coordinate system for overlays.
    let image=image::RgbaImage::from_raw(width,height,rgba).context("Invalid PDF raster.")?;
    encode(DynamicImage::ImageRgba8(image),PageManifest{page_index,page_count:count,original_size,
        crop_box:[crop.origin.x,crop.origin.y,crop.size.width,crop.size.height],rotation,render_width:width,render_height:height,
        transform:[transform.a,-transform.b,transform.c,-transform.d,transform.tx,height as f64-transform.ty],
        render_version:RENDER_VERSION.into(),png_hash:String::new(),first_frame_only:false})
}

/// Region coordinates are normalized to 1000; scale includes zoom and letterboxing.
pub fn displayed_box(region:[f64;4],image_size:[f64;2],viewport:[f64;2],zoom:f64)->Option<[f64;4]>{
    if region.iter().any(|v|!v.is_finite()||*v<0.0||*v>1000.0) || region[0]>=region[2] || region[1]>=region[3] ||
        image_size.iter().chain(viewport.iter()).any(|v|!v.is_finite()||*v<=0.0)||!zoom.is_finite()||zoom<=0.0{return None;}
    let scale=(viewport[0]/image_size[0]).min(viewport[1]/image_size[1])*zoom;
    let offset=[(viewport[0]-image_size[0]*scale)/2.0,(viewport[1]-image_size[1]*scale)/2.0];
    Some([offset[0]+region[0]/1000.0*image_size[0]*scale,offset[1]+region[1]/1000.0*image_size[1]*scale,
        (region[2]-region[0])/1000.0*image_size[0]*scale,(region[3]-region[1])/1000.0*image_size[1]*scale])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pdf() -> Vec<u8> {
        let stream="1 0 0 rg 20 140 40 40 re f\n";
        let objects=vec!["<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>".into(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R >>".into(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /CropBox [10 10 190 190] /Rotate 90 /Contents 6 0 R >>".into(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Rotate 180 /Contents 6 0 R >>".into(),
            format!("<< /Length {} >>\nstream\n{stream}endstream",stream.len())];
        let mut text="%PDF-1.4\n".to_owned(); let mut offsets=vec![0];
        for (index,object) in objects.iter().enumerate() {offsets.push(text.len());text.push_str(&format!("{} 0 obj\n{object}\nendobj\n",index+1));}
        let xref=text.len();text.push_str("xref\n0 7\n0000000000 65535 f \n");
        for offset in offsets.iter().skip(1){text.push_str(&format!("{offset:010} 00000 n \n"));}
        text.push_str(&format!("trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"));text.into_bytes()
    }
    #[cfg(target_os="macos")]
    #[test]
    fn test_eido_document_pdf_crop_rotation_pixels_and_hash() {
        let bytes=pdf();let original_hash=hash(&bytes);
        for index in 0..3 {
            let page=render(&bytes,index).unwrap(); let m=&page.manifest;
            assert_eq!(m.page_count,3);assert_eq!(m.page_index,index);assert_eq!(render(&bytes,index).unwrap().manifest.png_hash,m.png_hash);
            let image=image::load_from_memory(&page.png).unwrap().to_rgba8();
            let mut found=[u32::MAX,u32::MAX,0,0];
            for (x,y,pixel) in image.enumerate_pixels(){if pixel.0[0]>230 && pixel.0[1]<25 && pixel.0[2]<25{found[0]=found[0].min(x);found[1]=found[1].min(y);found[2]=found[2].max(x);found[3]=found[3].max(y);}}
            let [a,b,c,d,tx,ty]=m.transform;
            let corners=[[20.0,140.0],[60.0,140.0],[20.0,180.0],[60.0,180.0]].map(|[x,y]|[a*x+c*y+tx,b*x+d*y+ty]);
            let expected=[corners.iter().map(|p|p[0]).fold(f64::INFINITY,f64::min),corners.iter().map(|p|p[1]).fold(f64::INFINITY,f64::min),
                corners.iter().map(|p|p[0]).fold(f64::NEG_INFINITY,f64::max),corners.iter().map(|p|p[1]).fold(f64::NEG_INFINITY,f64::max)];
            for i in 0..4{assert!((found[i] as f64-expected[i]).abs()<3.0,"page {index}: pixel bounds {found:?}, transform bounds {expected:?}");}
        }
        assert_eq!(hash(&bytes),original_hash);assert!(render(&bytes,3).is_err());assert!(render(b"%PDF-damaged",0).is_err());
    }
    #[test]
    fn test_eido_document_attachment_binding_chunks_and_file_changes() {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("sample.pdf");std::fs::write(&path,pdf()).unwrap();
        let mut registry=DocumentRegistry::default();let descriptor=registry.select(&path).unwrap();
        let mut request=json!({"version":1,"sessionId":"one","turnId":"turn","selectionIdentity":descriptor.selection_identity,
            "attachmentId":descriptor.attachment_id,"expectedHash":descriptor.expected_hash,"action":"open"});
        assert!(registry.request(request.clone()).is_err());registry.bind(&descriptor,"one","turn").unwrap();
        let opened=registry.request(request.clone()).unwrap();request["handle"]=opened["handle"].clone();request["action"]="chunk".into();request["offset"]=0.into();
        let chunk=registry.request(request.clone()).unwrap();assert_eq!(hash(&STANDARD.decode(chunk["content"].as_str().unwrap()).unwrap()),descriptor.expected_hash);
        request["sessionId"]="two".into();assert!(registry.request(request.clone()).is_err());request["sessionId"]="one".into();
        request["offset"]=1.into();assert!(registry.request(request.clone()).is_err());
        request["action"]="release".into();registry.request(request.clone()).unwrap();assert!(registry.request(request.clone()).is_err());
        std::fs::write(path,b"%PDF-changed").unwrap();assert!(registry.bind(&descriptor,"one","next").unwrap_err().to_string().contains("New version"));
        let serialized=serde_json::to_string(&descriptor).unwrap();assert!(!serialized.contains(directory.path().to_str().unwrap()));
        assert_eq!(serde_json::from_str::<DocumentDescriptor>(&serialized).unwrap(),descriptor);
    }
    #[test]
    fn test_eido_document_reclaims_unowned_selections_without_evicting_active_owners() {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("sample.pdf");std::fs::write(&path,pdf()).unwrap();
        let mut registry=DocumentRegistry::default();
        let draft=registry.select(&path).unwrap();let other_window=registry.select(&path).unwrap();
        for index in 0..260 {
            let selected=registry.select(&path).unwrap_or_else(|error|panic!("selection {index} failed: {error}"));
            registry.bind(&selected,"task","turn").unwrap();
            let id=selected.attachment_id.clone();drop(selected);
            assert!(registry.descriptor(&id).is_ok(),"current turn retains its selection without a composer");
            registry.release_turn("task","turn");
        }
        assert!(registry.descriptor(&draft.attachment_id).is_ok());assert!(registry.descriptor(&other_window.attachment_id).is_ok());
        let closing=registry.select(&path).unwrap();let closing_id=closing.attachment_id.clone();registry.bind(&closing,"closing-task","unfinished").unwrap();drop(closing);
        registry.release_session("closing-task");assert!(registry.descriptor(&closing_id).is_err());
        assert!(registry.descriptor(&draft.attachment_id).is_ok());
        drop(draft);drop(other_window);
        let last=registry.select(&path).unwrap();assert_eq!(registry.selections.len(),1);drop(last);
    }
    #[test]
    fn test_eido_document_exif_normalization_and_invalid_regions() {
        let mut image=image::RgbImage::new(4,2); for (x,_,pixel) in image.enumerate_pixels_mut(){*pixel=if x<2 {image::Rgb([250,0,0])}else{image::Rgb([0,0,250])};}
        let mut jpeg=Cursor::new(Vec::new());DynamicImage::ImageRgb8(image).write_to(&mut jpeg,ImageFormat::Jpeg).unwrap();let jpeg=jpeg.into_inner();
        // EXIF TIFF orientation=6 (90 degrees clockwise), in a self-contained JPEG APP1 segment.
        let exif=b"Exif\0\0II\x2a\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00\x06\x00\x00\x00\x00\x00\x00\x00";
        let mut bytes=vec![0xff,0xd8,0xff,0xe1];bytes.extend_from_slice(&((exif.len()+2)as u16).to_be_bytes());bytes.extend_from_slice(exif);bytes.extend_from_slice(&jpeg[2..]);
        let page=render(&bytes,0).unwrap();assert_eq!([page.manifest.render_width,page.manifest.render_height],[2,4]);
        let parsed=image::load_from_memory(&page.png).unwrap().to_rgb8();assert!(parsed.get_pixel(0,0).0[0]>parsed.get_pixel(0,0).0[2]);
        assert_eq!(displayed_box([0.0,0.0,1000.0,1000.0],[200.0,100.0],[400.0,400.0],1.0),Some([0.0,100.0,400.0,200.0]));
        assert_eq!(displayed_box([0.0,0.0,1001.0,1000.0],[200.0,100.0],[400.0,400.0],1.0),None);
        assert_eq!(displayed_box([500.0,0.0,400.0,1000.0],[200.0,100.0],[400.0,400.0],1.0),None);
    }
}

/// Both draft previews and persisted source previews use the canonical image and
/// the same normalized region transform. GPUI applies the display scale factor.
pub(crate) fn page_element(image:Arc<gpui::Image>,manifest:&Value,boxes:&[[f64;4]],zoom:f64,available_width:f32,cx:&gpui::App)->gpui::AnyElement{
    use ui::prelude::*;
    let size=[manifest["renderWidth"].as_f64().unwrap_or(1.),manifest["renderHeight"].as_f64().unwrap_or(1.)];
    let scale=(available_width as f64/size[0]).min(320./size[1])*zoom;
    let viewport=[size[0]*scale,size[1]*scale];
    let mut page=div().relative().w(px(viewport[0] as f32)).h(px(viewport[1] as f32)).flex_shrink_0().child(gpui::img(image).size_full());
    for region in boxes{if let Some([x,y,w,h])=displayed_box(*region,size,viewport,1.){page=page.child(div().absolute().left(px(x as f32)).top(px(y as f32)).w(px(w as f32)).h(px(h as f32)).border_2().border_color(cx.theme().colors().text_accent));}}
    div().id("document-canonical-page").max_h(px(330.)).w_full().overflow_scroll().child(page).into_any_element()
}

pub(crate) fn open_preview(id:String,workspace:&gpui::WeakEntity<workspace::Workspace>,window:&mut gpui::Window,cx:&mut gpui::App){
    let registry=cx.global::<NativeDocuments>().0.clone();let descriptor=registry.lock().ok().and_then(|registry|registry.descriptor(&id).ok());
    let Some(descriptor)=descriptor else{crate::eido_reference::open_snapshot(acp_thread::MentionUri::Document{id,name:"Document unavailable".into()},Arc::from("This draft attachment is unavailable after reopening. Select the original document again to preview or extract it. Saved source versions remain available in Sources & Requirements."),None,workspace,window,cx);return;};let Some(workspace)=workspace.upgrade()else{return;};
    workspace.update(cx,|workspace,cx|workspace.toggle_modal(window,cx,move|window,cx|{
        let mut view=DocumentPreview{descriptor,registry,image:None,manifest:Value::Null,page:0,zoom:1.,error:String::new(),focus:cx.focus_handle()};view.load(window,cx);view
    }));
}
struct DocumentPreview{descriptor:DocumentDescriptor,registry:Arc<Mutex<DocumentRegistry>>,image:Option<Arc<gpui::Image>>,manifest:Value,page:usize,zoom:f64,error:String,focus:gpui::FocusHandle}
impl DocumentPreview{
    fn load(&mut self,window:&mut gpui::Window,cx:&mut gpui::Context<Self>){
        let registry=self.registry.clone();let descriptor=self.descriptor.clone();let page=self.page;self.image=None;
        let task=cx.background_spawn(async move{registry.lock().map_err(|_|anyhow!("Document registry unavailable"))?.preview(&descriptor,page)});
        cx.spawn_in(window,async move|this,cx|{let result=task.await;this.update(cx,|this,cx|{if this.page!=page{return;}match result{Ok(page)=>{this.image=Some(Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png,page.png.as_ref().clone())));this.manifest=serde_json::to_value(page.manifest).unwrap();},Err(error)=>this.error=error.to_string()};cx.notify();}).ok();}).detach();
    }
}
impl gpui::EventEmitter<gpui::DismissEvent> for DocumentPreview{}
impl workspace::ModalView for DocumentPreview{}
impl gpui::Focusable for DocumentPreview{fn focus_handle(&self,_cx:&gpui::App)->gpui::FocusHandle{self.focus.clone()}}
impl gpui::Render for DocumentPreview{
    fn render(&mut self,window:&mut gpui::Window,cx:&mut gpui::Context<Self>)->impl gpui::IntoElement{
        use ui::prelude::*;let width=f32::from(window.viewport_size().width).min(850.)-40.;let count=self.manifest["pageCount"].as_u64().unwrap_or(1) as usize;
        v_flex().key_context("DocumentPreview").track_focus(&self.focus).w(px(width)).p_4().gap_3().bg(cx.theme().colors().editor_background).border_1().border_color(cx.theme().colors().border).rounded_lg()
            .on_action(cx.listener(|_,_:&menu::Cancel,_,cx|cx.emit(gpui::DismissEvent)))
            .child(h_flex().justify_between().child(Label::new(self.descriptor.original_name.clone())).child(IconButton::new("close-document",IconName::Close).on_click(cx.listener(|_,_,_,cx|cx.emit(gpui::DismissEvent)))))
            .child(Label::new(eido_i18n::tr(cx, "research.preview_note")).size(LabelSize::Small).color(Color::Muted))
            .child(h_flex().gap_2().child(Button::new("previous-draft-page", eido_i18n::tr(cx, "research.previous")).disabled(self.page==0).on_click(cx.listener(|this,_,window,cx|{this.page=this.page.saturating_sub(1);this.load(window,cx);}))).child(Label::new(eido_i18n::tr_args(cx, "research.page_count", &[("page", (self.page+1).to_string()), ("count", count.to_string())]))).child(Button::new("next-draft-page", eido_i18n::tr(cx, "research.next")).disabled(self.page+1>=count).on_click(cx.listener(|this,_,window,cx|{this.page+=1;this.load(window,cx);}))).child(Button::new("zoom-draft-page", eido_i18n::tr(cx, "research.zoom")).on_click(cx.listener(|this,_,_,cx|{this.zoom=if this.zoom>=2.{0.75}else{this.zoom+0.25};cx.notify();}))))
            .when_some(self.image.clone(),|this,image|this.child(page_element(image,&self.manifest,&[],self.zoom,width-40.,cx)))
            .child(Label::new(crate::eido_research::error_label(&self.error, cx)).color(Color::Error))
    }
}
