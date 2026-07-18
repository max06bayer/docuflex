param(
  [Parameter(Mandatory = $true)]
  [string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$expectedSuffix = [IO.Path]::Combine('desktop', '.native-runtime', 'windows')
if (-not $RuntimeRoot.EndsWith($expectedSuffix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing unexpected runtime output path: $RuntimeRoot"
}

function Get-VerifiedArchive {
  param([string]$Url, [string]$Path, [string]$Sha256)
  Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
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
Copy-Item (Join-Path $pdfExtract 'pdf2htmlEX.exe') (Join-Path $pdfRuntime 'bin/pdf2htmlEX.exe')
Copy-Item (Join-Path $pdfExtract 'data') (Join-Path $pdfRuntime 'share/pdf2htmlEX') -Recurse
Copy-Item (Join-Path $pdfExtract 'LICENSE*') $pdfRuntime
@'
Windows native static pdf2htmlEX 0.14.6 with poppler-data.
Source and binary distribution: https://soft.rubypdf.com/software/pdf2htmlex-windows-version
Archive SHA-256: e92aa55699c3e9d9b4b4954bea157e59b5c3363cbe9a7713495c553544026354
'@ | Set-Content -Path (Join-Path $pdfRuntime 'SOURCE.txt') -Encoding UTF8
Remove-Item -LiteralPath $pdfArchive, $pdfExtract -Recurse -Force

choco install tesseract --yes --no-progress
$tesseractRoot = Join-Path $env:ProgramFiles 'Tesseract-OCR'
if (-not (Test-Path (Join-Path $tesseractRoot 'tesseract.exe'))) { throw 'Tesseract installation was not found.' }

$popplerArchive = Join-Path $RuntimeRoot 'poppler.zip'
Get-VerifiedArchive -Url 'https://github.com/oschwartz10612/poppler-windows/releases/download/v26.02.0-0/Release-26.02.0-0.zip' -Path $popplerArchive -Sha256 '993e4a94376ed712fafc7058d724ea0b943d118bbd2305cd9ed55174eb85cda5'
$popplerExtract = Join-Path $RuntimeRoot 'poppler-extract'
Expand-Archive -LiteralPath $popplerArchive -DestinationPath $popplerExtract
$popplerBin = Join-Path $popplerExtract 'poppler-26.02.0/Library/bin'
$ocrRuntime = Join-Path $RuntimeRoot 'ocr'
New-Item -ItemType Directory -Force -Path (Join-Path $ocrRuntime 'bin'), (Join-Path $ocrRuntime 'poppler/bin'), (Join-Path $ocrRuntime 'share/tessdata') | Out-Null
Copy-Item (Join-Path $tesseractRoot '*') (Join-Path $ocrRuntime 'bin') -Recurse -Force
Copy-Item (Join-Path $popplerBin '*') (Join-Path $ocrRuntime 'poppler/bin') -Recurse -Force
Copy-Item (Join-Path $popplerExtract 'poppler-26.02.0/Library/share') (Join-Path $ocrRuntime 'share/poppler') -Recurse -Force

$trainedData = @{
  eng = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
  deu = '19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d'
  osd = '9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff'
}
foreach ($language in $trainedData.Keys) {
  $destination = Join-Path $ocrRuntime "share/tessdata/$language.traineddata"
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/$language.traineddata" -OutFile $destination -UseBasicParsing
  $actual = (Get-FileHash -Path $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $trainedData[$language]) { throw "Checksum failed for $language.traineddata" }
}
Remove-Item -LiteralPath $popplerArchive, $popplerExtract -Recurse -Force
@'
Windows native OCR runtime.
Tesseract 5 package: https://community.chocolatey.org/packages/tesseract
Poppler 26.02.0: https://github.com/oschwartz10612/poppler-windows/releases/tag/v26.02.0-0
Tesseract fast language data 4.1.0: https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0
'@ | Set-Content -Path (Join-Path $ocrRuntime 'SOURCE.txt') -Encoding UTF8

choco install libreoffice-fresh --yes --no-progress
$officeSource = Join-Path $env:ProgramFiles 'LibreOffice'
if (-not (Test-Path (Join-Path $officeSource 'program/soffice.exe'))) { throw 'LibreOffice installation was not found.' }
Copy-Item $officeSource (Join-Path $RuntimeRoot 'office') -Recurse
@'
Windows x64 native LibreOffice runtime from the libreoffice-fresh Chocolatey package.
https://community.chocolatey.org/packages/libreoffice-fresh
'@ | Set-Content -Path (Join-Path $RuntimeRoot 'office/SOURCE.txt') -Encoding UTF8
