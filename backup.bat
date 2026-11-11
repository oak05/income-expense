@echo off
setlocal
cd /d "%~dp0"

set "APP_PORT=8080"
set "APP_USER=admin"
set "APP_PASSWORD="
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="APP_PORT" set "APP_PORT=%%B"
  if /i "%%A"=="APP_USER" set "APP_USER=%%B"
  if /i "%%A"=="APP_PASSWORD" set "APP_PASSWORD=%%B"
)

if not exist "backups" mkdir "backups"
for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%T"
set "OUT=backups\finance-%TS%.zip"

if defined APP_PASSWORD (
  curl -fs -u "%APP_USER%:%APP_PASSWORD%" -o "%OUT%" "http://localhost:%APP_PORT%/api/backup.zip"
) else (
  curl -fs -o "%OUT%" "http://localhost:%APP_PORT%/api/backup.zip"
)
if errorlevel 1 (
  if exist "%OUT%" del "%OUT%"
  echo  [!] Backup failed. Is the app running? Run start.bat first.
  if /i not "%~1"=="/quiet" pause
  exit /b 1
)

echo  Backup saved: %CD%\%OUT%
if /i not "%~1"=="/quiet" pause
