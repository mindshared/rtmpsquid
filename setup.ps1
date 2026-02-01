# RTMP Squid Setup Script for Windows
# Run this in PowerShell as Administrator

Write-Host "🦑 RTMP Squid Setup Script for Windows" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "⚠️  This script should be run as Administrator for best results" -ForegroundColor Yellow
    Write-Host "   Right-click PowerShell and select 'Run as Administrator'" -ForegroundColor Yellow
    Write-Host ""
    $continue = Read-Host "Continue anyway? (y/n)"
    if ($continue -ne 'y') {
        exit
    }
}

# Check if Node.js is installed
function Test-NodeInstalled {
    try {
        $nodeVersion = node -v 2>$null
        if ($nodeVersion) {
            Write-Host "✓ Node.js is installed: $nodeVersion" -ForegroundColor Green
            return $true
        }
    }
    catch {
        Write-Host "✗ Node.js is not installed" -ForegroundColor Red
        return $false
    }
    return $false
}

# Check if FFmpeg is installed
function Test-FFmpegInstalled {
    try {
        $ffmpegVersion = ffmpeg -version 2>$null | Select-Object -First 1
        if ($ffmpegVersion) {
            Write-Host "✓ FFmpeg is installed: $ffmpegVersion" -ForegroundColor Green
            return $true
        }
    }
    catch {
        Write-Host "✗ FFmpeg is not installed" -ForegroundColor Red
        return $false
    }
    return $false
}

# Check if winget is available
function Test-WingetAvailable {
    try {
        winget --version 2>$null | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

# Install Node.js
function Install-NodeJS {
    Write-Host ""
    Write-Host "Installing Node.js..." -ForegroundColor Yellow
    
    if (Test-WingetAvailable) {
        Write-Host "Using winget to install Node.js..." -ForegroundColor Cyan
        winget install OpenJS.NodeJS.LTS --silent
    }
    else {
        Write-Host "Please download and install Node.js manually:" -ForegroundColor Yellow
        Write-Host "https://nodejs.org/en/download/" -ForegroundColor Cyan
        Start-Process "https://nodejs.org/en/download/"
        Write-Host ""
        Read-Host "Press Enter after installing Node.js to continue"
    }
}

# Install FFmpeg
function Install-FFmpeg {
    Write-Host ""
    Write-Host "Installing FFmpeg..." -ForegroundColor Yellow
    
    if (Test-WingetAvailable) {
        Write-Host "Using winget to install FFmpeg..." -ForegroundColor Cyan
        winget install Gyan.FFmpeg --silent
        
        # Try to add FFmpeg to PATH
        $ffmpegPath = "C:\ffmpeg\bin"
        if (Test-Path $ffmpegPath) {
            $currentPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
            if ($currentPath -notlike "*$ffmpegPath*") {
                Write-Host "Adding FFmpeg to system PATH..." -ForegroundColor Cyan
                [Environment]::SetEnvironmentVariable("Path", "$currentPath;$ffmpegPath", "Machine")
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine")
            }
        }
    }
    else {
        Write-Host "Please download FFmpeg manually:" -ForegroundColor Yellow
        Write-Host "1. Download from: https://www.gyan.dev/ffmpeg/builds/" -ForegroundColor Cyan
        Write-Host "2. Extract to C:\ffmpeg" -ForegroundColor Cyan
        Write-Host "3. Add C:\ffmpeg\bin to your System PATH" -ForegroundColor Cyan
        Start-Process "https://www.gyan.dev/ffmpeg/builds/"
        Write-Host ""
        Read-Host "Press Enter after installing FFmpeg to continue"
    }
}

# Main installation flow
Write-Host "Checking prerequisites..." -ForegroundColor Cyan
Write-Host ""

$nodeInstalled = Test-NodeInstalled
$ffmpegInstalled = Test-FFmpegInstalled

Write-Host ""

# Install missing dependencies
if (-not $nodeInstalled) {
    $install = Read-Host "Node.js is not installed. Install it now? (y/n)"
    if ($install -eq 'y') {
        Install-NodeJS
        Write-Host ""
        Write-Host "⚠️  You may need to restart PowerShell for Node.js to be available" -ForegroundColor Yellow
        Write-Host ""
        $restart = Read-Host "Restart this script after Node.js installation? (y/n)"
        if ($restart -eq 'y') {
            exit
        }
    }
    else {
        Write-Host "Node.js is required. Exiting." -ForegroundColor Red
        exit 1
    }
}

if (-not $ffmpegInstalled) {
    $install = Read-Host "FFmpeg is not installed. Install it now? (y/n)"
    if ($install -eq 'y') {
        Install-FFmpeg
        Write-Host ""
        Write-Host "⚠️  You may need to restart PowerShell for FFmpeg to be available" -ForegroundColor Yellow
        Write-Host ""
    }
    else {
        Write-Host "FFmpeg is required. Exiting." -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "Installing RTMP Squid dependencies..." -ForegroundColor Cyan
Write-Host ""

# Install server dependencies
Write-Host "📦 Installing server dependencies..." -ForegroundColor Cyan
npm install

# Install client dependencies
Write-Host ""
Write-Host "📦 Installing client dependencies..." -ForegroundColor Cyan
Set-Location client
npm install
Set-Location ..

Write-Host ""
Write-Host "✓ Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "To start the application:" -ForegroundColor Cyan
Write-Host "  npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "Then open your browser to:" -ForegroundColor Cyan
Write-Host "  http://localhost:3000" -ForegroundColor White
Write-Host ""
Write-Host "🦑 Happy streaming!" -ForegroundColor Cyan

