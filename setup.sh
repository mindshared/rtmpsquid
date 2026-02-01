#!/bin/bash

# RTMP Squid Setup Script for Linux/macOS
# This script will install all dependencies and set up the application

set -e  # Exit on error

echo "🦑 RTMP Squid Setup Script"
echo "=========================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Detect OS
OS="unknown"
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
    if [ -f /etc/debian_version ]; then
        DISTRO="debian"
    elif [ -f /etc/redhat-release ]; then
        DISTRO="redhat"
    elif [ -f /etc/arch-release ]; then
        DISTRO="arch"
    else
        DISTRO="unknown"
    fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
fi

echo "Detected OS: $OS"
echo ""

# Check if Node.js is installed
check_node() {
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v)
        echo -e "${GREEN}✓${NC} Node.js is installed: $NODE_VERSION"
        return 0
    else
        echo -e "${RED}✗${NC} Node.js is not installed"
        return 1
    fi
}

# Check if FFmpeg is installed
check_ffmpeg() {
    if command -v ffmpeg &> /dev/null; then
        FFMPEG_VERSION=$(ffmpeg -version | head -n 1)
        echo -e "${GREEN}✓${NC} FFmpeg is installed: $FFMPEG_VERSION"
        return 0
    else
        echo -e "${RED}✗${NC} FFmpeg is not installed"
        return 1
    fi
}

# Install Node.js
install_node() {
    echo ""
    echo "Installing Node.js..."
    
    if [ "$OS" = "macos" ]; then
        if ! command -v brew &> /dev/null; then
            echo "Installing Homebrew first..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        brew install node
    elif [ "$OS" = "linux" ]; then
        if [ "$DISTRO" = "debian" ]; then
            curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
            sudo apt-get install -y nodejs
        elif [ "$DISTRO" = "redhat" ]; then
            curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
            sudo dnf install -y nodejs
        elif [ "$DISTRO" = "arch" ]; then
            sudo pacman -S --noconfirm nodejs npm
        else
            echo -e "${YELLOW}Please install Node.js manually from https://nodejs.org/${NC}"
            exit 1
        fi
    fi
}

# Install FFmpeg
install_ffmpeg() {
    echo ""
    echo "Installing FFmpeg..."
    
    if [ "$OS" = "macos" ]; then
        brew install ffmpeg
    elif [ "$OS" = "linux" ]; then
        if [ "$DISTRO" = "debian" ]; then
            sudo apt-get update
            sudo apt-get install -y ffmpeg
        elif [ "$DISTRO" = "redhat" ]; then
            sudo dnf install -y ffmpeg
        elif [ "$DISTRO" = "arch" ]; then
            sudo pacman -S --noconfirm ffmpeg
        else
            echo -e "${YELLOW}Please install FFmpeg manually from https://ffmpeg.org/${NC}"
            exit 1
        fi
    fi
}

# Main installation flow
echo "Checking prerequisites..."
echo ""

NODE_INSTALLED=0
FFMPEG_INSTALLED=0

check_node && NODE_INSTALLED=1 || true
check_ffmpeg && FFMPEG_INSTALLED=1 || true

echo ""

# Install missing dependencies
if [ $NODE_INSTALLED -eq 0 ]; then
    read -p "Node.js is not installed. Install it now? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        install_node
    else
        echo -e "${RED}Node.js is required. Please install it manually.${NC}"
        exit 1
    fi
fi

if [ $FFMPEG_INSTALLED -eq 0 ]; then
    read -p "FFmpeg is not installed. Install it now? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        install_ffmpeg
    else
        echo -e "${RED}FFmpeg is required. Please install it manually.${NC}"
        exit 1
    fi
fi

echo ""
echo "Installing RTMP Squid dependencies..."
echo ""

# Install server dependencies
echo "📦 Installing server dependencies..."
npm install

# Install client dependencies
echo ""
echo "📦 Installing client dependencies..."
cd client
npm install
cd ..

echo ""
echo -e "${GREEN}✓ Installation complete!${NC}"
echo ""
echo "To start the application:"
echo "  npm run dev"
echo ""
echo "Then open your browser to:"
echo "  http://localhost:3000"
echo ""
echo "🦑 Happy streaming!"

