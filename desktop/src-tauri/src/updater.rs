//! Updates from the GitHub releases: check for a newer version, download this
//! platform's installer (verified against the release's SHA256SUMS.txt), then
//! install it and restart once Docuflex has quit.
//!
//! Downloads go through the system `curl` (macOS, Windows 10+ and Linux ship
//! it), so the app needs no HTTP or TLS stack of its own.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager};

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/max06bayer/docuflex/releases/latest";
const DOWNLOAD_PREFIX: &str = "https://github.com/max06bayer/docuflex/releases/download/";

#[derive(Clone, serde::Serialize)]
pub struct UpdateInfo {
    current: String,
    latest: String,
    available: bool,
    #[serde(rename = "releaseUrl")]
    release_url: String,
}

#[derive(Clone)]
struct Asset {
    name: String,
    url: String,
    size: u64,
    checksums_url: Option<String>,
}

#[derive(Default)]
pub struct UpdateState {
    asset: Mutex<Option<Asset>>,
    downloaded: Mutex<Option<PathBuf>>,
}

#[derive(Clone, serde::Serialize)]
struct Progress {
    received: u64,
    total: u64,
}

fn curl() -> Command {
    let mut command = Command::new(if cfg!(target_os = "windows") { "curl.exe" } else { "curl" });
    command.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn fetch_text(url: &str) -> Result<String, String> {
    let output = curl()
        .args(["-fsSL", "--max-time", "20", "-H", "User-Agent: Docuflex-Updater", "-H", "Accept: application/vnd.github+json", url])
        .output()
        .map_err(|error| format!("Could not reach GitHub: {error}"))?;
    if !output.status.success() {
        return Err("Could not reach GitHub. Check your internet connection.".to_string());
    }
    String::from_utf8(output.stdout).map_err(|_| "GitHub sent an unreadable answer.".to_string())
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim_start_matches('v')
        .split(['.', '-'])
        .map_while(|part| part.parse().ok())
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (version_parts(latest), version_parts(current));
    for index in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(index).copied().unwrap_or(0), b.get(index).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn is_arch() -> bool {
    Path::new("/usr/bin/pacman").exists()
}

/// The installer for the platform this copy of Docuflex runs on.
fn wanted_asset(name: &str) -> bool {
    #[cfg(target_os = "macos")]
    return name.ends_with("_macOS_arm64.dmg");
    #[cfg(target_os = "windows")]
    return name.ends_with("-setup.exe");
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            return name.ends_with(".AppImage");
        }
        if is_arch() {
            return name.ends_with(".pkg.tar.zst");
        }
        return name.ends_with(".deb");
    }
    #[allow(unreachable_code)]
    false
}

#[tauri::command]
pub async fn docuflex_update_check(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let body = tauri::async_runtime::spawn_blocking(|| fetch_text(LATEST_RELEASE_API))
        .await
        .map_err(|error| error.to_string())??;
    let release: Value = serde_json::from_str(&body).map_err(|_| "GitHub sent an unreadable answer.".to_string())?;
    let latest = release["tag_name"].as_str().unwrap_or_default().trim_start_matches('v').to_string();
    let release_url = release["html_url"].as_str().unwrap_or_default().to_string();
    let assets = release["assets"].as_array().cloned().unwrap_or_default();
    let url_of = |asset: &Value| asset["browser_download_url"].as_str().unwrap_or_default().to_string();
    let checksums_url = assets
        .iter()
        .find(|asset| asset["name"].as_str() == Some("SHA256SUMS.txt"))
        .map(url_of);
    let asset = assets
        .iter()
        .find(|asset| asset["name"].as_str().is_some_and(wanted_asset))
        .map(|asset| Asset {
            name: asset["name"].as_str().unwrap_or_default().to_string(),
            url: url_of(asset),
            size: asset["size"].as_u64().unwrap_or(0),
            checksums_url: checksums_url.clone(),
        })
        .filter(|asset| asset.url.starts_with(DOWNLOAD_PREFIX));
    let available = !latest.is_empty() && is_newer(&latest, &current) && asset.is_some();
    *app.state::<UpdateState>().asset.lock().map_err(|_| "Update state is unavailable.")? = asset;
    Ok(UpdateInfo { current, latest, available, release_url })
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Downloads the installer found by the last check, reporting progress as
/// `docuflex-update-progress` events, and verifies its checksum.
#[tauri::command]
pub async fn docuflex_update_download(app: tauri::AppHandle) -> Result<(), String> {
    let asset = app
        .state::<UpdateState>()
        .asset
        .lock()
        .map_err(|_| "Update state is unavailable.")?
        .clone()
        .ok_or("Check for updates first.")?;
    let directory = std::env::temp_dir().join("docuflex-update");
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let destination = directory.join(&asset.name);
    let app_for_download = app.clone();
    let target = destination.clone();
    let path = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let mut child = curl()
            .args(["-fsSL", "--retry", "2", "-H", "User-Agent: Docuflex-Updater", "-o"])
            .arg(&target)
            .arg(&asset.url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start the download: {error}"))?;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                break status;
            }
            let received = fs::metadata(&target).map(|metadata| metadata.len()).unwrap_or(0);
            let _ = app_for_download.emit("docuflex-update-progress", Progress { received, total: asset.size });
            thread::sleep(Duration::from_millis(150));
        };
        if !status.success() {
            return Err("The download failed. Check your internet connection and try again.".to_string());
        }
        let _ = app_for_download.emit("docuflex-update-progress", Progress { received: asset.size, total: asset.size });
        if let Some(checksums_url) = &asset.checksums_url {
            let sums = fetch_text(checksums_url)?;
            let expected = sums
                .lines()
                .find_map(|line| {
                    let (hash, name) = line.split_once(char::is_whitespace)?;
                    (name.trim().trim_start_matches('*') == asset.name).then(|| hash.to_ascii_lowercase())
                })
                .ok_or("The release has no checksum for this download.")?;
            if sha256_of(&target)? != expected {
                let _ = fs::remove_file(&target);
                return Err("The download is damaged (checksum mismatch). Please try again.".to_string());
            }
        }
        Ok(target)
    })
    .await
    .map_err(|error| error.to_string())??;
    *app.state::<UpdateState>().downloaded.lock().map_err(|_| "Update state is unavailable.")? = Some(path);
    Ok(())
}

#[cfg(unix)]
fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// Starts a helper that waits for Docuflex to quit, installs the download and
/// opens the new version; then quits Docuflex.
#[tauri::command]
pub fn docuflex_update_install(app: tauri::AppHandle) -> Result<(), String> {
    let installer = app
        .state::<UpdateState>()
        .downloaded
        .lock()
        .map_err(|_| "Update state is unavailable.")?
        .clone()
        .ok_or("Download the update first.")?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let pid = std::process::id();
    let directory = installer.parent().unwrap_or(Path::new(".")).to_path_buf();

    #[cfg(target_os = "macos")]
    {
        let bundle = executable
            .ancestors()
            .nth(3)
            .filter(|path| path.extension().is_some_and(|extension| extension == "app"))
            .ok_or("Docuflex is not running from an app bundle.")?
            .to_path_buf();
        let parent = bundle.parent().ok_or("Unknown install location.")?;
        if fs::metadata(parent).map(|metadata| metadata.permissions().readonly()).unwrap_or(true) {
            return Err(format!("Docuflex cannot write to {}.", parent.display()));
        }
        let script = format!(
            "#!/bin/sh\nwhile kill -0 {pid} 2>/dev/null; do sleep 0.2; done\n\
             MNT=$(mktemp -d) || exit 1\n\
             hdiutil attach -nobrowse -readonly -mountpoint \"$MNT\" {dmg} >/dev/null || exit 1\n\
             rm -rf {new} && ditto \"$MNT/Docuflex.app\" {new} && rm -rf {app} && mv {new} {app}\n\
             hdiutil detach \"$MNT\" -quiet\n\
             open {app}\n",
            dmg = quote(&installer),
            app = quote(&bundle),
            new = quote(&bundle.with_extension("app.new")),
        );
        spawn_shell_script(&directory, &script)?;
    }

    #[cfg(target_os = "linux")]
    {
        let script = if let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
            format!(
                "#!/bin/sh\nwhile kill -0 {pid} 2>/dev/null; do sleep 0.2; done\n\
                 chmod +x {new} && mv -f {new} {old} && exec {old}\n",
                new = quote(&installer),
                old = quote(&appimage),
            )
        } else {
            let install = if is_arch() {
                format!("pkexec pacman -U --noconfirm {}", quote(&installer))
            } else {
                format!("pkexec apt-get install -y {}", quote(&installer))
            };
            format!(
                "#!/bin/sh\nwhile kill -0 {pid} 2>/dev/null; do sleep 0.2; done\n\
                 {install}\nexec {exe}\n",
                exe = quote(&executable),
            )
        };
        spawn_shell_script(&directory, &script)?;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let script = format!(
            "@echo off\r\n:wait\r\ntasklist /FI \"PID eq {pid}\" | find \"{pid}\" >nul && (timeout /t 1 /nobreak >nul & goto wait)\r\n\
             \"{setup}\" /S\r\nstart \"\" \"{exe}\"\r\n",
            setup = installer.display(),
            exe = executable.display(),
        );
        let path = directory.join("install-update.cmd");
        fs::write(&path, script).map_err(|error| error.to_string())?;
        Command::new("cmd")
            .args(["/C"])
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000 | 0x0000_0008) // CREATE_NO_WINDOW | DETACHED_PROCESS
            .spawn()
            .map_err(|error| format!("Could not start the installer: {error}"))?;
    }

    app.exit(0);
    Ok(())
}

#[cfg(unix)]
fn spawn_shell_script(directory: &Path, script: &str) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let path = directory.join("install-update.sh");
    fs::write(&path, script).map_err(|error| error.to_string())?;
    Command::new("/bin/sh")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own session, so quitting Docuflex does not take it down.
        .process_group(0)
        .spawn()
        .map_err(|error| format!("Could not start the installer: {error}"))?;
    Ok(())
}
