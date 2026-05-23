@echo off
setlocal

set "APP_DIR=%~dp0"
set "ROOT_DIR=%APP_DIR%.."

if exist "%ROOT_DIR%\launch-invoice-maker.bat" (
    call "%ROOT_DIR%\launch-invoice-maker.bat" %*
    exit /b %ERRORLEVEL%
)

echo ERROR: Could not find the main launcher next to the invoice-app folder.
pause
exit /b 1
