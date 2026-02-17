#!/bin/bash
# VPS Setup Script for Polymarket Trading Bot
# Run on fresh Ubuntu 22.04 instance

set -e

echo "=== Polymarket Bot VPS Setup ==="

# Update system
echo "[1/6] Updating system..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
echo "[2/6] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install git and build tools
echo "[3/6] Installing git and build essentials..."
sudo apt install -y git build-essential

# Clone repo
echo "[4/6] Cloning repository..."
cd ~
git clone https://github.com/docsofdw/prediction-mkt.git
cd prediction-mkt

# Install dependencies
echo "[5/6] Installing npm dependencies..."
npm install

# Install pm2 globally
echo "[6/6] Installing pm2 for process management..."
sudo npm install -g pm2

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. cd ~/prediction-mkt"
echo "  2. nano .env   (paste your credentials)"
echo "  3. npm run diagnose:trading   (test connection)"
echo "  4. pm2 start npm --name polybot -- run dev"
echo "  5. pm2 save && pm2 startup"
echo ""
