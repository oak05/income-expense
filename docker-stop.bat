@echo off
setlocal
cd /d "%~dp0"
echo  Stopping the app (your data is kept)...
docker compose down
echo  Stopped. Run docker-start.bat to open it again.
timeout /t 4 >nul
