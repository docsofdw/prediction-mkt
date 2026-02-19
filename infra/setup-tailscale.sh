#!/bin/bash
# Tailscale VPN Setup Script
# Creates a secure mesh network for accessing your VPS
# Usage: sudo bash setup-tailscale.sh

set -e

echo "=========================================="
echo "Tailscale VPN Setup"
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo bash setup-tailscale.sh)"
  exit 1
fi

# ─── Install Tailscale ─────────────────────────────────────
echo ""
echo "[1/4] Installing Tailscale..."

curl -fsSL https://tailscale.com/install.sh | sh

echo "Tailscale installed."

# ─── Configure Tailscale ───────────────────────────────────
echo ""
echo "[2/4] Configuring Tailscale..."

# Enable IP forwarding for Tailscale
echo 'net.ipv4.ip_forward = 1' >> /etc/sysctl.d/99-tailscale.conf
echo 'net.ipv6.conf.all.forwarding = 1' >> /etc/sysctl.d/99-tailscale.conf
sysctl -p /etc/sysctl.d/99-tailscale.conf

# ─── Start Tailscale ───────────────────────────────────────
echo ""
echo "[3/4] Starting Tailscale..."

systemctl enable tailscaled
systemctl start tailscaled

echo ""
echo "[4/4] Authenticate Tailscale..."
echo ""
echo "Run the following command to authenticate:"
echo ""
echo "  sudo tailscale up --ssh"
echo ""
echo "This will print a URL. Open it in your browser to"
echo "authenticate with your Tailscale account."
echo ""
echo "The --ssh flag enables Tailscale SSH, which allows"
echo "you to SSH via Tailscale without exposing port 22."
echo ""
echo "=========================================="
echo "After Authentication"
echo "=========================================="
echo ""
echo "1. Install Tailscale on your local machine:"
echo "   macOS: brew install tailscale"
echo "   Linux: curl -fsSL https://tailscale.com/install.sh | sh"
echo ""
echo "2. Authenticate your local machine:"
echo "   tailscale up"
echo ""
echo "3. Get this VPS's Tailscale IP:"
echo "   tailscale ip -4"
echo ""
echo "4. SSH via Tailscale (after firewall lockdown):"
echo "   ssh user@<tailscale-ip>"
echo ""
echo "5. Or use Tailscale SSH (no keys needed):"
echo "   ssh user@<hostname>"
echo ""
echo "=========================================="
