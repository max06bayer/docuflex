//! Sandboxed paths and durable access to explicitly user-selected documents.
//! No temporary home-directory or arbitrary-file exceptions are used.
use std::{fs, path::{Path, PathBuf}, process::Command};
use objc2::rc::Retained;
use objc2_foundation::{NSData, NSHomeDirectory, NSTemporaryDirectory, NSString, NSURL, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions};
use sha2::{Digest, Sha256};

pub fn home() -> PathBuf { PathBuf::from(NSHomeDirectory().to_string()) }
pub fn data_directory() -> PathBuf { home().join(".docuflex") }
pub fn cache_directory() -> PathBuf { home().join(".cache/docuflex") }
pub fn temporary_directory() -> PathBuf { PathBuf::from(NSTemporaryDirectory().to_string()) }
pub fn configure_service(command: &mut Command) {
    command.env("HOME", home())
        .env("DOCUFLEX_SANDBOX", "1")
        .env("DOCUFLEX_DATA_DIR", data_directory())
        .env("DOCUFLEX_CACHE_DIR", cache_directory())
        .env("TMPDIR", temporary_directory())
        .env("XDG_CACHE_HOME", home().join("Library/Caches"))
        .env("XDG_CONFIG_HOME", home().join("Library/Application Support"));
}

fn bookmark_file(path: &Path) -> PathBuf {
    let hash = Sha256::digest(path.as_os_str().as_encoded_bytes());
    data_directory().join("file-access").join(format!("{hash:x}.bookmark"))
}

pub struct Access { url: Retained<NSURL>, active: bool, pub path: PathBuf }
impl Access {
    /// Resolves an existing grant, or uses the implicit grant from Open/Save/Finder.
    /// This never grants access to an arbitrary path supplied by a model.
    pub fn open(path: &Path) -> Self {
        let resolved = fs::read(bookmark_file(path)).ok().and_then(|bytes| {
            let data = NSData::with_bytes(&bytes);
            // SAFETY: no out pointer is used; retained bookmark data lives for this call.
            unsafe { NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data, NSURLBookmarkResolutionOptions::WithSecurityScope | NSURLBookmarkResolutionOptions::WithoutUI,
                None, std::ptr::null_mut(),
            ) }.ok()
        });
        let url = resolved.unwrap_or_else(|| NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy())));
        // SAFETY: balanced by Drop, including on failed reads/writes.
        let active = unsafe { url.startAccessingSecurityScopedResource() };
        let actual = url.path().map(|value| PathBuf::from(value.to_string())).unwrap_or_else(|| path.to_path_buf());
        Self { url, active, path: actual }
    }
    pub fn remember(&self, original: &Path) {
        // A bookmark can only be created for an already authorised resource.
        if let Ok(data) = self.url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::WithSecurityScope, None, None,
        ) {
            let destination = bookmark_file(original);
            if let Some(parent) = destination.parent() {
                if fs::create_dir_all(parent).is_ok() {
                    use std::os::unix::fs::OpenOptionsExt;
                    use std::io::Write;
                    if let Ok(mut file) = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(destination) {
                        let _ = file.write_all(&data.to_vec());
                    }
                }
            }
        }
    }
}
impl Drop for Access {
    fn drop(&mut self) { if self.active { unsafe { self.url.stopAccessingSecurityScopedResource(); } } }
}

/// Import only known local AI data after a native, user-authorised folder pick.
/// Existing destination files are preserved; links and special files are refused.
pub fn import_previous_data(source: &Path) -> Result<u64, String> {
    let access = Access::open(source);
    let source = &access.path;
    let name = source.file_name().and_then(|name| name.to_str()).unwrap_or("");
    let (destination, allowed): (PathBuf, &[&str]) = match name {
        ".docuflex" => (data_directory(), &["openrouter-key", "ai-chats", "ai-memory.json", "ollama"]),
        "docuflex" => (cache_directory(), &["translate-python", "translate-data", "translate-cache", "translate-config", "translate-downloads"]),
        _ => return Err("Choose the previous .docuflex data folder or .cache/docuflex translation folder.".into()),
    };
    if source == &destination { return Err("This is already the current data folder.".into()); }
    fn copy_missing(source: &Path, target: &Path, count: &mut u64, bytes: &mut u64) -> Result<(), String> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() { return Err("Import stopped: symbolic links are not supported.".into()); }
        if let Ok(existing) = fs::symlink_metadata(target) {
            if existing.file_type().is_symlink() { return Err("Import destination contains a symbolic link.".into()); }
        }
        if metadata.is_dir() {
            fs::create_dir_all(target).map_err(|error| error.to_string())?;
            fs::set_permissions(target, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
            for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                copy_missing(&entry.path(), &target.join(entry.file_name()), count, bytes)?;
            }
        } else if metadata.is_file() {
            if target.exists() { return Ok(()); }
            *count += 1; *bytes += metadata.len();
            if *count > 100_000 || *bytes > 16 * 1024 * 1024 * 1024 { return Err("The import exceeds the local AI data limit.".into()); }
            let mut input = fs::File::open(source).map_err(|error| error.to_string())?;
            let mut output = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(target).map_err(|error| error.to_string())?;
            if let Err(error) = std::io::copy(&mut input, &mut output) {
                drop(output); let _ = fs::remove_file(target); return Err(error.to_string());
            }
        } else { return Err("Import stopped: special files are not supported.".into()); }
        Ok(())
    }
    fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
    let mut files = 0;
    let mut bytes = 0;
    for name in allowed {
        let path = source.join(name);
        if path.try_exists().map_err(|error| error.to_string())? {
            copy_missing(&path, &destination.join(name), &mut files, &mut bytes)?;
        }
    }
    Ok(files)
}
