$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$env:OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe"
$env:OPENAI_QA_MODEL = "gpt-5.4-mini"

$node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path $node)) {
  $node = "node"
}

Write-Host "Starting Call QA Reviewer at http://127.0.0.1:4377/"
Write-Host "Keep this window open while using the app."
Write-Host ""
& $node server.js
