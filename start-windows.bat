@echo off
setlocal
cd /d "%~dp0"
if not exist data mkdir data
set "LOG_FILE=%~dp0data\server.log"
set "OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe"
set "OPENAI_QA_MODEL=gpt-5.4-mini"

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:4377/api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if %ERRORLEVEL% EQU 0 (
  echo Call QA Reviewer is already running.
  echo Opening http://127.0.0.1:4377/
  start "" "http://127.0.0.1:4377/"
  pause
  goto :eof
)

set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%BUNDLED_NODE%" (
  echo Starting Call QA Reviewer at http://127.0.0.1:4377/
  echo Keep this window open while using the app.
  echo A copy of startup messages is saved to "%LOG_FILE%".
  echo.
  echo [%DATE% %TIME%] Starting with bundled Node >> "%LOG_FILE%"
  "%BUNDLED_NODE%" server.js
  echo.
  echo The app stopped. See "%LOG_FILE%" for details.
  pause
  goto :eof
)

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo Starting Call QA Reviewer at http://127.0.0.1:4377/
  echo Keep this window open while using the app.
  echo A copy of startup messages is saved to "%LOG_FILE%".
  echo.
  echo [%DATE% %TIME%] Starting with system Node >> "%LOG_FILE%"
  node server.js
  echo.
  echo The app stopped. See "%LOG_FILE%" for details.
  pause
  goto :eof
)

echo Node.js was not found. Install Node.js 20 or newer, then run this file again.
pause
