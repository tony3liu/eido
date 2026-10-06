use anyhow::{Context as _, Result, ensure};
use serde_json::{Value, json};
use std::{env, path::{Path, PathBuf}};

/// Called from main before the application starts threads or resolves resources.
/// A bundle carries code/resources only; all mutable state lives in user storage.
pub fn configure() -> Result<Option<PathBuf>> {
    let executable = env::current_exe()?;
    let Some(contents) = executable.parent().and_then(Path::parent) else { return Ok(None); };
    let resources = contents.join("Resources");
    let root = resources.join("runtime");
    if !root.join("eido-runtime.json").is_file() { return Ok(None); }
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("eido-runtime.json"))?)?;
    ensure!(manifest["version"] == 1 && manifest["pi"] == "1.0.4", "Unsupported Eido runtime manifest");
    let helpers = contents.join("Helpers");
    let node = helpers.join("node");
    ensure!(node.is_file() && root.join("packages/acp/src/cli.js").is_file(), "Bundled agent runtime is incomplete");
    let data = env::var_os("EIDO_USER_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| {
        paths::home_dir().join("Library/Application Support/Eido")
    });
    let pi = env::var_os("EIDO_PI_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| data.join("pi"));
    std::fs::create_dir_all(&pi)?;
    let mut search = vec![helpers, root.join("node_modules/.bin")];
    if let Some(path) = env::var_os("PATH") { search.extend(env::split_paths(&path)); }
    // SAFETY: startup is single-threaded, before GPUI/runtime worker creation.
    unsafe {
        env::set_var("EIDO_ROOT", &root);
        env::set_var("EIDO_NODE", &node);
        env::set_var("EIDO_PI_CONFIG_DIR", &pi);
        env::set_var("PI_CODING_AGENT_DIR", &pi);
        env::set_var("EIDO_NATIVE_SOURCE_ROOT", resources.join("editor"));
        env::set_var("EIDO_INSTALLED_RUNTIME", "1");
        env::set_var("PLAYWRIGHT_BROWSERS_PATH", resources.join("browsers"));
        env::set_var("PATH", env::join_paths(search)?);
    }
    Ok(Some(data.join("native")))
}

pub fn prepare_settings(directory: &Path) -> Result<()> {
    let root = PathBuf::from(env::var_os("EIDO_ROOT").context("Missing bundled runtime")?);
    let node = env::var("EIDO_NODE")?;
    let path = directory.join("config/settings.json");
    // Existing settings may contain JSONC and user formatting. Runtime paths
    // are provided by the bundled server factory; never rewrite this file on boot.
    if path.exists() { return Ok(()); }
    let mut settings = json!({});
    let defaults: Value = serde_json::from_slice(&std::fs::read(root.join("native/appearance.json"))?)?;
    fn merge(target: &mut Value, defaults: &Value) {
        if let (Some(target), Some(defaults)) = (target.as_object_mut(), defaults.as_object()) {
            for (key, value) in defaults {
                if let Some(current) = target.get_mut(key) { merge(current, value); }
                else { target.insert(key.clone(), value.clone()); }
            }
        }
    }
    merge(&mut settings, &defaults);
    merge(&mut settings, &json!({"telemetry":{"metrics":false,"diagnostics":false},"auto_update":false,
        "disable_ai":false,"enable_language_server":false,"auto_install_extensions":{"html":false}}));
    settings["node"] = json!({"path":node,"ignore_system_version":false});
    settings["agent_servers"]["eido-pi"] = json!({"type":"custom","command":node,
        "args":[root.join("packages/acp/src/cli.js")],"env":{"EIDO_ROOT":root,"PI_CODING_AGENT_DIR":env::var("EIDO_PI_CONFIG_DIR")?}});
    std::fs::create_dir_all(path.parent().unwrap())?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temporary, serde_json::to_vec_pretty(&settings)?)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}
