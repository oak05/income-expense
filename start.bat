@echo off
setlocal
cd /d "%~dp0"
title Income-Expense App

rem ---- Runs the app directly on Windows - no Docker needed. (Docker version: docker-start.bat) ----

set "PY=%~dp0.venv\Scripts\python.exe"

rem first run, or requirements.txt changed after an update: install / update what the app needs
set "NEED_SETUP="
if not exist "%PY%" set "NEED_SETUP=1"
if not exist "tessdata\tha.traineddata" set "NEED_SETUP=1"
if not exist ".venv\requirements.installed" set "NEED_SETUP=1"
if not defined NEED_SETUP fc /b "requirements.txt" ".venv\requirements.installed" >nul 2>&1 || set "NEED_SETUP=1"
if defined NEED_SETUP (
  echo  Setting up the app on this computer - the first time takes a few minutes...
  call "%~dp0setup.bat" /auto || exit /b 1
  title Income-Expense App
)

set "APP_PORT=8080"
set "BIND_ADDRESS=127.0.0.1"
set "APP_USER=admin"
set "APP_PASSWORD="
set "ALLOWED_HOSTS="
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="APP_PORT" set "APP_PORT=%%B"
  if /i "%%A"=="BIND_ADDRESS" set "BIND_ADDRESS=%%B"
  if /i "%%A"=="APP_USER" set "APP_USER=%%B"
  if /i "%%A"=="APP_PASSWORD" set "APP_PASSWORD=%%B"
  if /i "%%A"=="ALLOWED_HOSTS" set "ALLOWED_HOSTS=%%B"
)

rem data (finance.db + receipts) lives in the "data" folder next to this file
set "DATA_DIR=%~dp0data"
rem Tesseract program + the Thai/English language files downloaded by setup.bat
set "PATH=%ProgramFiles%\Tesseract-OCR;%PATH%"
set "TESSDATA_PREFIX=%~dp0tessdata"
set "OMP_THREAD_LIMIT=2"
rem the app uses Asia/Bangkok when TZ is empty
set "TZ="
set "PYTHONUTF8=1"
set "PYTHONUNBUFFERED=1"

rem already running: restart it so changes in .env take effect
curl -fs -o nul "http://localhost:%APP_PORT%/api/health" && (
  echo  Restarting the app to apply the settings in .env...
  call "%~dp0stop.bat" /quiet
  timeout /t 1 /nobreak >nul
)

rem server messages go to logs\app.log (view with logs.bat); keep one older copy when it gets big
if not exist "logs" mkdir "logs"
set "LOG=%~dp0logs\app.log"
if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF GTR 5000000 move /y "%LOG%" "%LOG%.old" >nul

echo.
echo  Starting the app...
start "Income-Expense server - close this window to stop the app" /min cmd /c ""%PY%" -m uvicorn app.main:app --host %BIND_ADDRESS% --port %APP_PORT% --no-server-header >> "%LOG%" 2>&1"

for /l %%i in (1,1,30) do (
  curl -fs -o nul "http://localhost:%APP_PORT%/api/health" && goto ready
  timeout /t 1 /nobreak >nul
)
echo.
echo  [!] The app did not start. Last lines of logs\app.log:
echo.
powershell -NoProfile -Command "Get-Content -LiteralPath '%LOG%' -Tail 15 -Encoding UTF8"
echo.
echo      Common cause: port %APP_PORT% is already used - change APP_PORT in .env
echo.
pause
exit /b 1

:ready
echo  Ready:  http://localhost:%APP_PORT%
if "%BIND_ADDRESS%"=="0.0.0.0" (
  echo  From a phone on the same Wi-Fi / Tailscale, open one of:
  for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notlike 'vEthernet*' } | ForEach-Object { $_.IPAddress }"`) do echo          http://%%I:%APP_PORT%
)
echo.
echo  The app runs in the minimized "Income-Expense server" window.
echo  Stop it with stop.bat or by closing that window. Messages: logs.bat
start "" "http://localhost:%APP_PORT%"
timeout /t 8 >nul
exit /b 0
