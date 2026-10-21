fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&[
                    "take_pending_pdf",
                    "start_window_drag",
                    "docuflex_save_prompt",
                    "docuflex_save_overwrite",
                    "docuflex_update_check",
                    "docuflex_update_download",
                    "docuflex_update_install",
                ]),
        ),
    )
    .expect("failed to run tauri-build");
}
