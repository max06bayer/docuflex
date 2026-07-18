# Docuflex for macOS

This directory packages the existing Docuflex `/editor` route as a native Tauri app. The web application source remains unchanged.

The packaged app applies its macOS-only titlebar and sidebar arrangement from `runtime/chrome.js`; those overrides are injected by Tauri and are not included in the website.

## Build

The current native bundle targets Apple Silicon macOS 26 or newer.

```sh
cd desktop
npm install
npm run build
```

The staging step builds the existing SvelteKit application and PDFBox server, downloads and verifies the pinned Node.js LTS runtime, creates a trimmed Java 17 runtime with `jlink`, bundles the native Apple Silicon `pdf2htmlEX` and OCR runtimes, and generates the macOS icon from `public/macos-icon-iOS-Default-1024x1024@1x.png`.

The resulting app is written below `desktop/src-tauri/target/release/bundle/macos/Docuflex.app`.

The app runs its frontend and PDFBox services only on `127.0.0.1`. No hosted Docuflex backend is used. Edit Text uses the bundled native `pdf2htmlEX`, Poppler, FontForge, data files, and relocated dylibraries, so conversion works offline without Homebrew, MacPorts, Docker, or a Linux compatibility layer.

The converter bundle is under `vendor/pdf2htmlEX-macos-arm64`. Its pinned source versions and checksums are recorded in `runtime/pdf2htmlEX-SOURCE.txt`; `scripts/bundle-pdf2htmlex.mjs` recreates the relocatable runtime after the native sources have been built.

Offline OCR uses bundled Apple Silicon builds of Tesseract, `pdftoppm`, and `pdfunite`, plus pinned English, German, and orientation language data. `scripts/bundle-ocr.mjs` recreates that relocatable runtime under `vendor/ocr-macos-arm64`.
