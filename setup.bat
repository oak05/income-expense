@echo off
setlocal
cd /d "%~dp0"
title Income-Expense setup (no Docker)

rem ---- Setup for running without Docker (start.bat runs this by itself when needed): uv (Python manager), Tesseract OCR, Thai language data, Python packages ----

where winget >nul 2>&1 || (
  echo  [!] winget is missing. Install "App Installer" from the Microsoft Store, then run this again.
  pause
  exit /b 1
)

set "UV="
for /f "delims=" %%U in ('where uv 2^>nul') do if not defined UV set "UV=%%U"
if not defined UV for /r "%LOCALAPPDATA%\Microsoft\WinGet\Packages" %%U in (uv.exe) do if exist "%%U" if not defined UV set "UV=%%U"
if not defined UV (
  echo  Installing uv...
  winget install --id astral-sh.uv --exact --silent --accept-package-agreements --accept-source-agreements
  for /r "%LOCALAPPDATA%\Microsoft\WinGet\Packages" %%U in (uv.exe) do if exist "%%U" if not defined UV set "UV=%%U"
)
if not defined UV (
  echo  [!] Could not install uv.
  pause
  exit /b 1
)

if not exist "%ProgramFiles%\Tesseract-OCR\tesseract.exe" (
  echo  Installing Tesseract OCR - click Yes if Windows asks for permission...
  winget install --id UB-Mannheim.TesseractOCR --exact --silent --accept-package-agreements --accept-source-agreements
)
if not exist "%ProgramFiles%\Tesseract-OCR\tesseract.exe" (
  echo  [!] Tesseract was not installed. Receipt scanning will not work until it is.
  pause
)

if not exist "tessdata" mkdir "tessdata"
for %%L in (eng osd) do if not exist "tessdata\%%L.traineddata" copy /y "%ProgramFiles%\Tesseract-OCR\tessdata\%%L.traineddata" "tessdata\" >nul
if not exist "tessdata\tha.traineddata" (
  echo  Downloading Thai language data for OCR...
  curl -fsSL -o "tessdata\tha.traineddata" https://github.com/tesseract-ocr/tessdata/raw/main/tha.traineddata || (
    echo  [!] Download failed - check the internet connection and run this again.
    pause
    exit /b 1
  )
)

echo  Setting up Python 3.13 and the app's packages...
rem --managed-python: use uv's own Python, never a test/old Python installed on the PC
if not exist ".venv\Scripts\python.exe" "%UV%" venv --python 3.13 --managed-python .venv || goto failed
"%UV%" pip install --python .venv\Scripts\python.exe -r requirements.txt || goto failed
rem start.bat compares this copy with requirements.txt to know when an update needs new packages
copy /y "requirements.txt" ".venv\requirements.installed" >nul

echo.
echo  Setup finished.
if /i "%~1"=="/auto" exit /b 0
echo  Run start.bat to open the app.
pause
exit /b 0

:failed
echo  [!] Setup failed - read the messages above.
pause
exit /b 1
