fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&["docuflex_save_prompt", "docuflex_save_overwrite"]),
        ),
    )
    .expect("failed to run tauri-build");
}
