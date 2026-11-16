@echo off
setlocal
cd /d "%~dp0"

rem ---- Stops the app started by start.bat (no Docker). Docker version: docker-stop.bat ----

set "APP_PORT=8080"
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="APP_PORT" set "APP_PORT=%%B"
)

echo  Stopping the app (your data is kept)...
rem stop only the python process that is serving this app on APP_PORT
powershell -NoProfile -Command ^
  "$ids = Get-NetTCPConnection -LocalPort %APP_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique;" ^
  "$n = 0; foreach ($id in $ids) { $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\";" ^
  "  if ($p.CommandLine -match 'app\.main:app') { Stop-Process -Id $id -Force; $n++ } }" ^
  "if ($n) { Write-Host '  Stopped. Run start.bat to open it again.' } else { Write-Host '  The app was not running.' }"
if /i not "%~1"=="/quiet" timeout /t 3 >nul
exit /b 0
