use std::{
    ffi::OsString,
    fs::{self, File},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
#[cfg(target_os = "linux")]
use tauri::webview::PageLoadEvent;
use tauri::{webview::DownloadEvent, Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, TitleBarStyle};
use url::Url;

const FRONTEND_PORT: u16 = 43_127;
const BACKEND_PORT: u16 = 43_128;

fn configure_platform_webview() {
    #[cfg(target_os = "linux")]
    {
        // The AppImage launcher must set these before WebKitGTK is loaded.
        // Native distro packages use the host WebKit/Mesa stack unmodified.
        if std::env::var_os("APPIMAGE").is_some() {
            if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
            if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
                std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            }
        }
    }
}

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
                #[cfg(target_os = "windows")]
                {
                    let _ = Command::new("taskkill.exe")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
            }
            for child in children.iter_mut() {
                let _ = child.wait();
            }
            children.clear();
        }
    }
}

fn runtime_executable(resource_root: &Path, runtime: &str, name: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    let executable = format!("{name}.exe");
    #[cfg(not(target_os = "windows"))]
    let executable = name.to_string();
    resource_root
        .join("runtime")
        .join(runtime)
        .join("bin")
        .join(executable)
}

fn python_executable(resource_root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    return resource_root.join("runtime/python/python.exe");
    #[cfg(not(target_os = "windows"))]
    return resource_root.join("runtime/python/bin/python3");
}

fn office_executable(resource_root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    return resource_root.join("runtime/office/program/soffice.com");
    #[cfg(target_os = "linux")]
    return resource_root.join("runtime/office/program/soffice");
    #[cfg(target_os = "macos")]
    return resource_root.join("runtime/office/bin/soffice");
}

fn ocr_executable(resource_root: &Path, name: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if name != "tesseract" {
            return resource_root
                .join("runtime/ocr/poppler/bin")
                .join(format!("{name}.exe"));
        }
    }
    runtime_executable(resource_root, "ocr", name)
}

fn supervised_command(
    resource_root: &Path,
    parent_pid: &str,
    executable: &Path,
    arguments: &[OsString],
) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("powershell.exe");
        command
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(resource_root.join("runtime/supervise.ps1"))
            .arg("-DocuflexParentPid")
            .arg(parent_pid)
            .arg("-FilePath")
            .arg(executable)
            .arg("--")
            .args(arguments);
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new("/bin/sh");
        command
            .arg(resource_root.join("runtime/supervise.sh"))
            .arg(parent_pid)
            .arg(executable)
            .args(arguments);
        command
    }
}

fn isolate_service_environment(_command: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        // AppImage's AppRun prepends its Ubuntu libraries so the GUI can load.
        // Those paths must not leak into our self-contained Java and Node
        // runtimes on rolling distributions such as Arch/CachyOS.
        _command.env_remove("LD_LIBRARY_PATH");
        _command.env_remove("LD_PRELOAD");
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
    let java = runtime_executable(resource_root, "java", "java");
    let node = runtime_executable(resource_root, "node", "node");
    let pdf2html = resource_root.join("runtime/pdf2htmlEX");
    let ocr = resource_root.join("runtime/ocr");
    let python = python_executable(resource_root);
    let document_converter = office_executable(resource_root);
    let parent_pid = std::process::id().to_string();
    #[cfg(target_os = "windows")]
    let classpath = "backend/out;backend/lib/pdfbox-app-3.0.8.jar";
    #[cfg(not(target_os = "windows"))]
    let classpath = "backend/out:backend/lib/pdfbox-app-3.0.8.jar";
    let backend_arguments = [
        OsString::from("-cp"),
        OsString::from(classpath),
        OsString::from("DocuflexPdfServer"),
    ];
    let (backend_stdout, backend_stderr) = log_file(log_directory, "pdf-backend")?;
    let mut backend_command =
        supervised_command(resource_root, &parent_pid, &java, &backend_arguments);
    isolate_service_environment(&mut backend_command);
    let backend = backend_command
        .current_dir(resource_root)
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

    let frontend_arguments = [OsString::from("frontend/index.js")];
    let (frontend_stdout, frontend_stderr) = log_file(log_directory, "frontend")?;
    let mut frontend_command =
        supervised_command(resource_root, &parent_pid, &node, &frontend_arguments);
    isolate_service_environment(&mut frontend_command);
    frontend_command
        .current_dir(resource_root)
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
        .env(
            "PDF2HTMLEX_BIN",
            runtime_executable(resource_root, "pdf2htmlEX", "pdf2htmlEX"),
        )
        .env("PDF2HTMLEX_DATA_DIR", pdf2html.join("share/pdf2htmlEX"))
        .env("PDFTOPPM_BIN", ocr_executable(resource_root, "pdftoppm"))
        .env("PDFUNITE_BIN", ocr_executable(resource_root, "pdfunite"))
        .env("TESSERACT_BIN", ocr_executable(resource_root, "tesseract"))
        .env("TESSDATA_PREFIX", ocr.join("share/tessdata"))
        .env("PDF_RENDER_BIN", ocr_executable(resource_root, "pdftoppm"))
        .env("DOCUMENT_CONVERTER_PYTHON", python)
        .env("DOCUMENT_CONVERTER_BIN", document_converter);
    #[cfg(target_os = "macos")]
    frontend_command
        .env("FONTCONFIG_PATH", pdf2html.join("etc/fonts"))
        .env("FONTCONFIG_FILE", "fonts.conf");
    let frontend = frontend_command
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

fn log_tail(path: &Path) -> String {
    let Ok(contents) = fs::read_to_string(path) else {
        return "log unavailable".to_string();
    };
    let mut tail = contents.chars().rev().take(4_000).collect::<Vec<_>>();
    tail.reverse();
    let tail = tail.into_iter().collect::<String>();
    if tail.trim().is_empty() {
        "log is empty".to_string()
    } else {
        tail
    }
}

fn service_startup_error(log_directory: &Path) -> String {
    let backend = log_tail(&log_directory.join("pdf-backend.log"));
    let frontend = log_tail(&log_directory.join("frontend.log"));
    format!(
        "Docuflex local services did not start within 60 seconds.\n\
         Logs: {}\n\n[pdf-backend]\n{}\n\n[frontend]\n{}",
        log_directory.display(),
        backend,
        frontend
    )
}

fn wait_for_services(log_directory: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if service_ready(BACKEND_PORT, "/health") && service_ready(FRONTEND_PORT, "/editor") {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(120));
    }
    Err(service_startup_error(log_directory).into())
}

fn choose_download_destination(suggested: &Path) -> Option<PathBuf> {
    let suggested_name = suggested
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("document.pdf");
    rfd::FileDialog::new()
        .set_file_name(suggested_name)
        .save_file()
}

fn editor_initialization_script() -> &'static str {
    include_str!("../../runtime/chrome.js")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_platform_webview();
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

            if let Err(error) = wait_for_services(&log_directory) {
                eprintln!("{error}");
                services_for_setup.stop();
                return Err(error);
            }

            let editor_url = Url::parse(&format!("http://127.0.0.1:{FRONTEND_PORT}/editor"))?;
            let allowed_origin = editor_url.origin().ascii_serialization();
            let window_actions = app.handle().clone();
            #[cfg(target_os = "linux")]
            let page_load_marker = std::env::var_os("DOCUFLEX_PAGE_LOAD_MARKER").map(PathBuf::from);
            let window_builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(editor_url))
                    .title("Docuflex")
                    .inner_size(1440.0, 920.0)
                    .min_inner_size(960.0, 640.0)
                    .center();
            #[cfg(target_os = "macos")]
            let window_builder = window_builder
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(LogicalPosition::new(24.0, 24.0));
            #[cfg(target_os = "windows")]
            let window_builder = window_builder.decorations(false).shadow(true);
            #[cfg(target_os = "linux")]
            let window_builder = window_builder.on_page_load(move |_window, payload| {
                if payload.event() == PageLoadEvent::Finished && payload.url().path() == "/editor" {
                    if let Some(marker) = &page_load_marker {
                        let _ = fs::write(marker, b"editor-loaded\n");
                    }
                }
            });
            window_builder
                .initialization_script(editor_initialization_script())
                .on_navigation(move |url| {
                    if url.scheme() == "about" {
                        return true;
                    }
                    if url.origin().ascii_serialization() == allowed_origin {
                        if let Some(action) = url.path().strip_prefix("/__docuflex/window/") {
                            if let Some(window) = window_actions.get_webview_window("main") {
                                match action {
                                    "minimize" => {
                                        let _ = window.minimize();
                                    }
                                    "maximize" => {
                                        if window.is_maximized().unwrap_or(false) {
                                            let _ = window.unmaximize();
                                        } else {
                                            let _ = window.maximize();
                                        }
                                    }
                                    "close" => {
                                        let _ = window.close();
                                    }
                                    _ => {}
                                }
                            }
                            return false;
                        }
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
