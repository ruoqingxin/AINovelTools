@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" %*
set "DEV_EXIT_CODE=%ERRORLEVEL%"
if not "%DEV_EXIT_CODE%"=="0" (
    echo.
    echo Startup failed. Review the error above.
    pause
)
exit /b %DEV_EXIT_CODE%
