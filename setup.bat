@echo off
REM RTMP Squid Setup Script for Windows (Batch)
REM This is a simple wrapper that launches the PowerShell script

echo.
echo 🦑 RTMP Squid Setup
echo ==================
echo.
echo Launching PowerShell setup script...
echo.

REM Check if PowerShell is available
where powershell >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: PowerShell not found!
    echo Please install PowerShell or run setup.ps1 manually
    pause
    exit /b 1
)

REM Run the PowerShell script
powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Setup failed. Please check the error messages above.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Setup completed successfully!
pause

