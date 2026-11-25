param(
  [Parameter(Mandatory = $true)]
  [string]$RuntimeRoot,
  # Already-unpacked Tesseract-OCR and LibreOffice folders. When empty,
  # Tesseract comes from Chocolatey and LibreOffice from the pinned official
  # MSI. A local build can pass portable copies (the Tesseract installer
  # unpacked with 7-Zip) so nothing is installed system-wide.
  [string]$TesseractRoot = '',
  [string]$OfficeRoot = ''
)

$ErrorActionPreference = 'Stop'
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$expectedSuffix = [IO.Path]::Combine('desktop', '.native-runtime', 'windows')
if (-not $RuntimeRoot.EndsWith($expectedSuffix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing unexpected runtime output path: $RuntimeRoot"
}

function Get-VerifiedArchive {
  param([string]$Url, [string]$Path, [string]$Sha256)
  & curl.exe --location --fail --retry 5 --retry-all-errors --connect-timeout 30 --output $Path $Url
  if ($LASTEXITCODE -ne 0) { throw "Download failed after retries: $Url" }
  $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) { throw "Checksum failed for $Url" }
}

if (Test-Path $RuntimeRoot) { Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null

$pdfArchive = Join-Path $RuntimeRoot 'pdf2htmlEX.zip'
Get-VerifiedArchive -Url 'https://soft.rubypdf.com/download/pdf2htmlex/pdf2htmlEX-win32-0.14.6-with-poppler-data.zip' -Path $pdfArchive -Sha256 'e92aa55699c3e9d9b4b4954bea157e59b5c3363cbe9a7713495c553544026354'
$pdfExtract = Join-Path $RuntimeRoot 'pdf2htmlEX-extract'
Expand-Archive -LiteralPath $pdfArchive -DestinationPath $pdfExtract
$pdfRuntime = Join-Path $RuntimeRoot 'pdf2htmlEX'
New-Item -ItemType Directory -Force -Path (Join-Path $pdfRuntime 'bin'), (Join-Path $pdfRuntime 'share') | Out-Null
Copy-Item (Join-Path $pdfExtract 'pdf2htmlEX.exe') (Join-Path $pdfRuntime 'bin/pdf2htmlEX-native.exe')
$pdfWrapperSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../runtime/pdf2htmlEX-windows-wrapper.rs'))
& rustc $pdfWrapperSource -C opt-level=z -C strip=symbols -o (Join-Path $pdfRuntime 'bin/pdf2htmlEX.exe')
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the native Windows pdf2htmlEX launcher.' }
Copy-Item (Join-Path $pdfExtract 'data') (Join-Path $pdfRuntime 'share/pdf2htmlEX') -Recurse
Copy-Item (Join-Path $pdfExtract 'LICENSE*') $pdfRuntime
@'
Windows native static pdf2htmlEX 0.14.6 with poppler-data and a native launcher
that normalizes the newer endpoint CLI shorthands for this legacy build.
Source and binary distribution: https://soft.rubypdf.com/software/pdf2htmlex-windows-version
Archive SHA-256: e92aa55699c3e9d9b4b4954bea157e59b5c3363cbe9a7713495c553544026354
'@ | Set-Content -Path (Join-Path $pdfRuntime 'SOURCE.txt') -Encoding UTF8
Remove-Item -LiteralPath $pdfArchive, $pdfExtract -Recurse -Force

if ($TesseractRoot) {
  $tesseractRoot = [IO.Path]::GetFullPath($TesseractRoot)
} else {
  choco install tesseract --yes --no-progress
  $tesseractRoot = Join-Path $env:ProgramFiles 'Tesseract-OCR'
}
if (-not (Test-Path (Join-Path $tesseractRoot 'tesseract.exe'))) { throw 'Tesseract installation was not found.' }

$popplerArchive = Join-Path $RuntimeRoot 'poppler.zip'
Get-VerifiedArchive -Url 'https://github.com/oschwartz10612/poppler-windows/releases/download/v26.02.0-0/Release-26.02.0-0.zip' -Path $popplerArchive -Sha256 '993e4a94376ed712fafc7058d724ea0b943d118bbd2305cd9ed55174eb85cda5'
$popplerExtract = Join-Path $RuntimeRoot 'poppler-extract'
Expand-Archive -LiteralPath $popplerArchive -DestinationPath $popplerExtract
$popplerBin = Join-Path $popplerExtract 'poppler-26.02.0/Library/bin'
$ocrRuntime = Join-Path $RuntimeRoot 'ocr'
New-Item -ItemType Directory -Force -Path (Join-Path $ocrRuntime 'bin'), (Join-Path $ocrRuntime 'poppler/bin'), (Join-Path $ocrRuntime 'share/tessdata') | Out-Null
Copy-Item (Join-Path $tesseractRoot '*') (Join-Path $ocrRuntime 'bin') -Recurse -Force -Exclude '$PLUGINSDIR'
Copy-Item (Join-Path $tesseractRoot 'tessdata/*') (Join-Path $ocrRuntime 'share/tessdata') -Recurse -Force
Copy-Item (Join-Path $popplerBin '*') (Join-Path $ocrRuntime 'poppler/bin') -Recurse -Force
Copy-Item (Join-Path $popplerExtract 'poppler-26.02.0/Library/share') (Join-Path $ocrRuntime 'share/poppler') -Recurse -Force

$trainedData = @{
  eng = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
  deu = '19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d'
  osd = '9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff'
}
foreach ($language in $trainedData.Keys) {
  $destination = Join-Path $ocrRuntime "share/tessdata/$language.traineddata"
  Get-VerifiedArchive -Url "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/$language.traineddata" -Path $destination -Sha256 $trainedData[$language]
}
Remove-Item -LiteralPath $popplerArchive, $popplerExtract -Recurse -Force
@'
Windows native OCR runtime.
Tesseract 5 package: https://community.chocolatey.org/packages/tesseract
Poppler 26.02.0: https://github.com/oschwartz10612/poppler-windows/releases/tag/v26.02.0-0
Tesseract fast language data 4.1.0: https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0
'@ | Set-Content -Path (Join-Path $ocrRuntime 'SOURCE.txt') -Encoding UTF8

if ($OfficeRoot) {
  $officeSource = [IO.Path]::GetFullPath($OfficeRoot)
} else {
  # The same pinned LibreOffice as macOS and Linux, from the archive (which,
  # unlike "stable", keeps every release). An administrative image unpacks the
  # MSI without installing anything.
  $officeMsi = Join-Path $RuntimeRoot 'libreoffice.msi'
  Get-VerifiedArchive -Url 'https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/win/x86_64/LibreOffice_26.2.6.3_Win_x86-64.msi' -Path $officeMsi -Sha256 'f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660'
  $officeSource = Join-Path $RuntimeRoot 'office-image'
  $unpack = Start-Process msiexec.exe -ArgumentList '/a', "`"$officeMsi`"", '/qn', "TARGETDIR=`"$officeSource`"" -Wait -PassThru
  if ($unpack.ExitCode -ne 0) { throw "Could not unpack the LibreOffice MSI (exit $($unpack.ExitCode))." }
  Remove-Item -LiteralPath $officeMsi -Force
}
if (-not (Test-Path (Join-Path $officeSource 'program/soffice.com'))) { throw 'LibreOffice console launcher was not found.' }
$officeRuntime = Join-Path $RuntimeRoot 'office'
New-Item -ItemType Directory -Force -Path $officeRuntime | Out-Null
# An administrative MSI image also holds the .msi itself and the installer's
# System/System64 folders; only the application folders are needed.
Get-ChildItem -LiteralPath $officeSource |
  Where-Object { $_.Name -notmatch '\.msi$' -and $_.Name -notin @('System', 'System64') } |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $officeRuntime -Recurse }
# The MSI installs the Visual C++ runtime system-wide; ship it next to
# soffice instead so Office works on PCs that don't have it.
$vcRuntime = Join-Path $officeSource 'System64'
if (Test-Path $vcRuntime) {
  Copy-Item (Join-Path $vcRuntime '*.dll') (Join-Path $officeRuntime 'program') -Force
}
@'
Windows x64 LibreOffice 26.2.6 (administrative image of the official MSI).
https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/win/x86_64/
MSI SHA-256: f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660
'@ | Set-Content -Path (Join-Path $officeRuntime 'SOURCE.txt') -Encoding UTF8
$officeImage = Join-Path $RuntimeRoot 'office-image'
if (Test-Path $officeImage) { Remove-Item -LiteralPath $officeImage -Recurse -Force }
