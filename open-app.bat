@echo off
setlocal
cd /d "%~dp0"

set "APP_URL=http://127.0.0.1:4377/"

where powershell >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%APP_URL%api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null } catch { Start-Process -FilePath '%~dp0start-windows.bat' -WorkingDirectory '%~dp0'; Start-Sleep -Seconds 2 }; Start-Process '%APP_URL%'"
  goto :eof
)

start "" "%APP_URL%"
