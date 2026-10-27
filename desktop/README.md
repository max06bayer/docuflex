# Docuflex desktop builds

The desktop package runs the existing `/editor` application and its Java backend entirely on loopback. Each native package contains Node.js, a reduced Java 17 runtime, Python conversion libraries, OCR tools and language data, `pdf2htmlEX`, and an office converter. Runtime staging fails instead of silently using tools installed on the end user's computer.

## Native packages

- macOS Apple Silicon: `npm run build` in `desktop/` creates `Docuflex.app`.
- Windows x64: the `Desktop native builds` workflow creates a current-user NSIS installer and embeds the offline WebView2 installer.
- Linux x64: the same workflow creates an AppImage and a Debian package on Ubuntu 22.04.

Windows and Linux are deliberately compiled on native GitHub runners. Tauri recommends native CI for installers, and this also ensures that every bundled helper executable matches the target operating system.

Before packaging, `npm run smoke` verifies the bundled Node and Java runtimes, Python imports, all three OCR language files, real OCR output, a real PDF-to-HTML conversion that preserves text, editable PDF-to-Word/PowerPoint/Excel output (including scans and rotated pages), and a real LibreOffice-to-PDF conversion. A failed native dependency prevents the installer artifact from being uploaded.

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

## Editable file conversion

The Convert quick tool processes documents locally in desktop builds. Word uses
native editable text boxes and vector drawings at PDF coordinates, keeping each
source run exactly once. This preserves page dimensions and avoids paragraph
reflow, with the tradeoff that text is edited in positioned boxes. Usable fonts
are embedded when their embedding rights permit it; Latin Modern uses the bundled
Docuflex Modern faces, and missing maths glyphs use bundled Noto Sans Math (OFL).
PowerPoint uses native text boxes and vector shapes, preserves source image
transparency and paint order, and embeds editable fonts where permitted.
Restricted fonts use bundled substitutes with source-width text spacing.
Excel extracts tables into
typed cells and preserves source illustrations. Scanned pages use bundled
Tesseract (English/German).

macOS now bundles checksum-verified LibreOffice 26.2.6 for Office filters, rather
than the former `textutil` shim. `DOCUFLEX_OFFICE_RUNTIME` can still select a
prepared runtime with `bin/soffice`. All platforms install the shared
`scripts/requirements-conversion.txt`; no documents are uploaded to another service.

The website runs the same conversion engine on its server. Nixpacks installs
LibreOffice and Fontconfig, and production startup registers `backend/fonts`
for LibreOffice under the unprivileged runtime user. The website build runs
`scripts/test-server-conversion.sh` against its installed Python, Office and OCR
tools; a failing conversion regression prevents that build from completing.
Desktop conversion stays on the user's computer; website conversion uploads the
document to the Docuflex server. Cross-platform output still needs verification
in the deployed Linux environment, particularly Office imports and font fallback.

PDF does not retain the original Office structure. Conversion cannot recover
spreadsheet formulas or guarantee the original fonts, reading order, graphics,
or layout for every PDF. Fonts unavailable as reusable Unicode fonts may be
substituted by the Office application. OCR reconstructs text on scanned pages;
original scan fonts and artwork are not recoverable reliably. There is no
page-screenshot fallback on conversion failure. Limits are 500 pages, a bounded
worker, and the API's existing upload/output limits.

Local regression tests (also run during desktop smoke testing):

```sh
TESSERACT_BIN="$PWD/desktop/src-tauri/resources/runtime/ocr/bin/tesseract" \
TESSDATA_PREFIX="$PWD/desktop/src-tauri/resources/runtime/ocr/share/tessdata" \
  desktop/src-tauri/resources/runtime/python/bin/python3 scripts/test-editable-conversion.py
```

For API tests, start the local server with the staged `DOCUMENT_CONVERTER_PYTHON`,
`DOCUMENT_CONVERTER_BIN`, `TESSERACT_BIN`, and `TESSDATA_PREFIX` paths, then run
`node scripts/test-conversion-api.mjs`. It creates synthetic fixtures in
`tmp/conversion/`; `DOCUFLEX_TEST_ORIGIN` selects the server (default port 5178).
