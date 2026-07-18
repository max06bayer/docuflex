use std::{
    fs::{self, File},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    webview::DownloadEvent, LogicalPosition, Manager, TitleBarStyle, WebviewUrl,
    WebviewWindowBuilder,
};
use url::Url;

const FRONTEND_PORT: u16 = 43_127;
const BACKEND_PORT: u16 = 43_128;

struct Services {
    children: Mutex<Vec<Child>>,
}

impl Services {
    fn stop(&self) {
        if let Ok(mut children) = self.children.lock() {
            for child in children.iter_mut() {
                #[cfg(unix)]
                unsafe {
                    libc::kill(child.id() as i32, libc::SIGTERM);
                }
            }
            for child in children.iter_mut() {
                let _ = child.wait();
            }
            children.clear();
        }
    }
}

impl Drop for Services {
    fn drop(&mut self) {
        self.stop();
    }
}

fn log_file(
    log_directory: &Path,
    name: &str,
) -> Result<(Stdio, Stdio), Box<dyn std::error::Error>> {
    fs::create_dir_all(log_directory)?;
    let output = File::create(log_directory.join(format!("{name}.log")))?;
    let errors = output.try_clone()?;
    Ok((Stdio::from(output), Stdio::from(errors)))
}

fn spawn_services(
    resource_root: &Path,
    log_directory: &Path,
) -> Result<Vec<Child>, Box<dyn std::error::Error>> {
    let java = resource_root.join("runtime/java/bin/java");
    let node = resource_root.join("runtime/node/bin/node");
    let pdf2html = resource_root.join("runtime/pdf2htmlEX");
    let ocr = resource_root.join("runtime/ocr");
    let python = resource_root.join("runtime/python/bin/python3");
    let document_converter = resource_root.join("runtime/soffice-shim.sh");
    let supervisor = resource_root.join("runtime/supervise.sh");
    let parent_pid = std::process::id().to_string();
    let classpath = "backend/out:backend/lib/pdfbox-app-3.0.8.jar";
    let (backend_stdout, backend_stderr) = log_file(log_directory, "pdf-backend")?;
    let backend = Command::new("/bin/sh")
        .current_dir(resource_root)
        .arg(&supervisor)
        .arg(&parent_pid)
        .arg(java)
        .args(["-cp", classpath, "DocuflexPdfServer"])
        .env("PDF_BACKEND_HOST", "127.0.0.1")
        .env("PDF_BACKEND_PORT", BACKEND_PORT.to_string())
        .env(
            "JAVA_TOOL_OPTIONS",
            "-Xms64m -XX:MaxRAMPercentage=50 -XX:+ExitOnOutOfMemoryError",
        )
        .stdin(Stdio::null())
        .stdout(backend_stdout)
        .stderr(backend_stderr)
        .spawn()?;

    let (frontend_stdout, frontend_stderr) = log_file(log_directory, "frontend")?;
    let frontend = Command::new("/bin/sh")
        .current_dir(resource_root)
        .arg(&supervisor)
        .arg(&parent_pid)
        .arg(node)
        .arg("frontend/index.js")
        .env("HOST", "127.0.0.1")
        .env("PORT", FRONTEND_PORT.to_string())
        .env("ORIGIN", format!("http://127.0.0.1:{FRONTEND_PORT}"))
        .env(
            "PDF_BACKEND_URL",
            format!("http://127.0.0.1:{BACKEND_PORT}"),
        )
        .env("BODY_SIZE_LIMIT", (230_u64 * 1024 * 1024).to_string())
        .env("ADDRESS_HEADER", "")
        .env("PROTOCOL_HEADER", "")
        .env("HOST_HEADER", "")
        .env("PDF2HTMLEX_BIN", pdf2html.join("bin/pdf2htmlEX"))
        .env("PDF2HTMLEX_DATA_DIR", pdf2html.join("share/pdf2htmlEX"))
        .env("FONTCONFIG_PATH", pdf2html.join("etc/fonts"))
        .env("FONTCONFIG_FILE", "fonts.conf")
        .env("PDFTOPPM_BIN", ocr.join("bin/pdftoppm"))
        .env("PDFUNITE_BIN", ocr.join("bin/pdfunite"))
        .env("TESSERACT_BIN", ocr.join("bin/tesseract"))
        .env("TESSDATA_PREFIX", ocr.join("share/tessdata"))
        .env("PDF_RENDER_BIN", ocr.join("bin/pdftoppm"))
        .env("DOCUMENT_CONVERTER_PYTHON", python)
        .env("DOCUMENT_CONVERTER_BIN", document_converter)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null())
        .stdout(frontend_stdout)
        .stderr(frontend_stderr)
        .spawn()?;

    Ok(vec![backend, frontend])
}

fn service_ready(port: u16, path: &str) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0_u8; 32];
    let Ok(size) = stream.read(&mut response) else {
        return false;
    };
    response[..size].starts_with(b"HTTP/1.1 200")
}

fn wait_for_services() -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if service_ready(BACKEND_PORT, "/health") && service_ready(FRONTEND_PORT, "/editor") {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(120));
    }
    Err("Docuflex local services did not start within 20 seconds.".into())
}

fn choose_download_destination(suggested: &Path) -> Option<PathBuf> {
    let suggested_name = suggested
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("document.pdf");
    let script = r#"
on run argv
  set suggestedName to item 1 of argv
  set chosenFile to choose file name with prompt "Save exported document" default name suggestedName
  return POSIX path of chosenFile
end run
"#;
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .arg(suggested_name)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let selected = String::from_utf8(output.stdout).ok()?;
    let selected = selected.trim();
    if selected.is_empty() {
        None
    } else {
        Some(PathBuf::from(selected))
    }
}

fn editor_initialization_script() -> &'static str {
    include_str!("../../runtime/chrome.js")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let services = Arc::new(Services {
        children: Mutex::new(Vec::new()),
    });
    let services_for_setup = Arc::clone(&services);
    let services_for_exit = Arc::clone(&services);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            },
        ))
        .setup(move |app| {
            let resource_root = app.path().resource_dir()?.join("resources");
            let log_directory = app.path().app_log_dir()?;
            let children = spawn_services(&resource_root, &log_directory)?;
            *services_for_setup
                .children
                .lock()
                .map_err(|_| "Could not track local services.")? = children;

            if let Err(error) = wait_for_services() {
                services_for_setup.stop();
                return Err(error);
            }

            let editor_url = Url::parse(&format!("http://127.0.0.1:{FRONTEND_PORT}/editor"))?;
            let allowed_origin = editor_url.origin().ascii_serialization();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(editor_url))
                .title("Docuflex")
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(LogicalPosition::new(24.0, 24.0))
                .inner_size(1440.0, 920.0)
                .min_inner_size(960.0, 640.0)
                .center()
                .initialization_script(editor_initialization_script())
                .on_navigation(move |url| {
                    if url.scheme() == "about" {
                        return true;
                    }
                    url.origin().ascii_serialization() == allowed_origin && url.path() == "/editor"
                })
                .on_download(|_webview, event| match event {
                    DownloadEvent::Requested { destination, .. } => {
                        if let Some(selected) = choose_download_destination(destination) {
                            *destination = selected;
                            true
                        } else {
                            false
                        }
                    }
                    DownloadEvent::Finished { .. } => true,
                    _ => true,
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build Docuflex");

    app.run(move |_app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            services_for_exit.stop();
        }
    });
}
