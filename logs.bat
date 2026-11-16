@echo off
cd /d "%~dp0"
rem ---- Shows the messages of the app started by start.bat. Docker version: docker-logs.bat ----
if not exist "logs\app.log" (
  echo  No log yet - run start.bat first.
  pause
  exit /b 1
)
echo  Showing app logs. Press Ctrl+C to exit.
powershell -NoProfile -Command "Get-Content -LiteralPath 'logs\app.log' -Tail 100 -Wait -Encoding UTF8"
