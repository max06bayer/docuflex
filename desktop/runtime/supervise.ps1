param(
  [Parameter(Mandatory = $true)]
  [int]$DocuflexParentPid,
  [Parameter(Mandatory = $true)]
  [string]$FilePath,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ProgramArguments
)

$ErrorActionPreference = 'Stop'
if ($ProgramArguments.Count -gt 0 -and $ProgramArguments[0] -eq '--') {
  $ProgramArguments = $ProgramArguments[1..($ProgramArguments.Count - 1)]
}

$service = Start-Process -FilePath $FilePath -ArgumentList $ProgramArguments -NoNewWindow -PassThru
try {
  while (-not $service.HasExited -and (Get-Process -Id $DocuflexParentPid -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 500
  }
}
finally {
  if (-not $service.HasExited) {
    & taskkill.exe /PID $service.Id /T /F 2>$null | Out-Null
  }
  $service.WaitForExit()
}
