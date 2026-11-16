@echo off
setlocal
cd /d "%~dp0"
title Income-Expense App

docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo  [!] Docker Desktop is not running.
  echo      Open Docker Desktop, wait for "Engine running", then run start.bat again.
  echo.
  pause
  exit /b 1
)

set "APP_PORT=8080"
set "APP_IMAGE="
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="APP_PORT" set "APP_PORT=%%B"
  if /i "%%A"=="APP_IMAGE" set "APP_IMAGE=%%B"
)

set "PREBUILT="
if defined APP_IMAGE if not "%APP_IMAGE:/=%"=="%APP_IMAGE%" set "PREBUILT=1"

echo.
if defined PREBUILT (
  echo  Downloading the latest image %APP_IMAGE% ...
  docker compose pull app
  if errorlevel 1 goto pullfailed
  docker compose up -d --no-build
) else (
  echo  Building and starting the app - the first run takes 1-3 minutes...
  echo.
  docker compose up -d --build
)
if errorlevel 1 (
  echo.
  echo  [!] Could not start the app. Read the messages above.
  echo      Common cause: port %APP_PORT% is already used - change APP_PORT in .env
  echo.
  pause
  exit /b 1
)

echo.
echo  Waiting for the app to be ready...
for /l %%i in (1,1,40) do (
  curl -fs -o nul "http://localhost:%APP_PORT%/api/health" && goto ready
  timeout /t 1 /nobreak >nul
)
echo  [!] The app is taking longer than expected. Check logs.bat
pause
exit /b 1

:ready
echo  Ready:  http://localhost:%APP_PORT%
start "" "http://localhost:%APP_PORT%"
timeout /t 4 >nul
exit /b 0

:pullfailed
echo.
echo  [!] Could not download %APP_IMAGE%
echo      If the package on GitHub is private, run once:  docker login ghcr.io
echo      or clear APP_IMAGE in .env to build the image on this computer.
echo.
pause
exit /b 1
