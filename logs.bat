@echo off
cd /d "%~dp0"
echo  Showing app logs. Press Ctrl+C to exit.
docker compose logs -f --tail 100
