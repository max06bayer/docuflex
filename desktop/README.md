# Docuflex desktop builds

The desktop package runs the existing `/editor` application and its Java backend entirely on loopback. Each native package contains Node.js, a reduced Java 17 runtime, Python conversion libraries, OCR tools and language data, `pdf2htmlEX`, and an office converter. Runtime staging fails instead of silently using tools installed on the end user's computer.

## Native packages

- macOS Apple Silicon: `npm run build` in `desktop/` creates `Docuflex.app`.
- Windows x64: the `Desktop native builds` workflow creates a current-user NSIS installer and embeds the offline WebView2 installer.
- Linux x64: the same workflow creates an AppImage and a Debian package on Ubuntu 22.04.

Windows and Linux are deliberately compiled on native GitHub runners. Tauri recommends native CI for installers, and this also ensures that every bundled helper executable matches the target operating system.

Before packaging, `npm run smoke` verifies the bundled Node and Java runtimes, Python imports, all three OCR language files, real OCR output, a real PDF-to-HTML conversion that preserves text, and LibreOffice availability. A failed native dependency prevents the installer artifact from being uploaded.

For a local Apple Silicon build:

```sh
cd desktop
npm install
npm run build
```

The app is written to `desktop/src-tauri/target/release/bundle/macos/Docuflex.app`. It targets macOS 26 or newer and uses the icon exported at `public/macos-icon-iOS-Default-1024x1024@1x.png`.

The relocatable macOS converter and OCR inputs remain under `vendor/pdf2htmlEX-macos-arm64` and `vendor/ocr-macos-arm64`. Their pinned source versions and checksums are recorded in `runtime/pdf2htmlEX-SOURCE.txt` and the vendor `SOURCE.txt` files; the existing bundling scripts can recreate them from native builds.

## Window chrome

- macOS retains the integrated traffic lights and desktop-specific sidebar/header alignment.
- Windows uses the web header with a draggable native window frame and Windows controls on the right; the utility area reserves the corresponding space.
- Linux uses the normal desktop window decoration and the web header unchanged.
