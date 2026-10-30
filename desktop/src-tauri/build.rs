fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&[
                    "take_pending_pdf",
                    "start_window_drag",
                    "macos_resize_window",
                    "docuflex_save_prompt",
                    "docuflex_save_overwrite",
                    "docuflex_print_pdf",
                    "docuflex_update_check",
                    "docuflex_update_download",
                    "docuflex_update_install",
                ]),
        ),
    )
    .expect("failed to run tauri-build");
}
