#!/bin/bash
# Firewall Configuration Script
# Locks down VPS to Tailscale-only access
# Usage: sudo bash firewall-rules.sh

set -e

echo "=========================================="
echo "Firewall Configuration"
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo bash firewall-rules.sh)"
  exit 1
fi

# Check if Tailscale is running
if ! tailscale status &>/dev/null; then
  echo "ERROR: Tailscale is not running or not authenticated."
  echo "Please run setup-tailscale.sh first and authenticate."
  exit 1
fi

# Get Tailscale IP
TAILSCALE_IP=$(tailscale ip -4)
echo "Tailscale IP: $TAILSCALE_IP"

# ─── UFW Configuration ─────────────────────────────────────
echo ""
echo "[1/3] Configuring UFW firewall..."

# Reset UFW to defaults
ufw --force reset

# Set default policies
ufw default deny incoming
ufw default allow outgoing

# Allow SSH only from Tailscale CGNAT range (100.64.0.0/10)
# This is the IP range Tailscale uses for its mesh network
ufw allow from 100.64.0.0/10 to any port 22 proto tcp comment 'SSH via Tailscale'

# Allow all traffic on Tailscale interface
ufw allow in on tailscale0 comment 'Tailscale interface'

# Allow loopback
ufw allow in on lo

echo "UFW rules configured."

# ─── Enable UFW ────────────────────────────────────────────
echo ""
echo "[2/3] Enabling UFW..."

# Enable UFW (non-interactive)
ufw --force enable

echo "UFW enabled."

# ─── Verify Configuration ──────────────────────────────────
echo ""
echo "[3/3] Verifying firewall configuration..."

ufw status verbose

echo ""
echo "=========================================="
echo "Firewall Configuration Complete!"
echo "=========================================="
echo ""
echo "Current rules:"
echo "  - All incoming traffic DENIED by default"
echo "  - SSH allowed ONLY from Tailscale network (100.64.0.0/10)"
echo "  - All Tailscale interface traffic allowed"
echo "  - All outgoing traffic allowed"
echo ""
echo "IMPORTANT:"
echo "  Before closing this SSH session, open a NEW terminal"
echo "  and verify you can SSH via Tailscale:"
echo ""
echo "  ssh $(whoami)@$TAILSCALE_IP"
echo ""
echo "  If you cannot connect, run:"
echo "  sudo ufw allow 22/tcp"
echo ""
echo "=========================================="

# ─── Cloud Firewall Reminder ───────────────────────────────
echo ""
echo "CLOUD FIREWALL REMINDER"
echo "=========================================="
echo ""
echo "For maximum security, also configure your cloud"
echo "provider's firewall to block all inbound traffic:"
echo ""
echo "AWS Lightsail / EC2:"
echo "  - Edit Security Group"
echo "  - Remove all inbound rules (or set to deny all)"
echo ""
echo "DigitalOcean:"
echo "  - Networking > Firewalls"
echo "  - Create firewall with no inbound rules"
echo "  - Apply to your droplet"
echo ""
echo "Linode:"
echo "  - Network > Firewalls"
echo "  - Create firewall with no inbound rules"
echo "  - Apply to your Linode"
echo ""
echo "This creates defense-in-depth: even if UFW fails,"
echo "the cloud firewall blocks all public access."
echo "=========================================="
