#!/bin/bash
# VPS Hardening Script for Prediction Market Bot
# Run this on your existing VPS to apply security hardening
# Usage: sudo bash harden-vps.sh

set -e

echo "=========================================="
echo "VPS Security Hardening Script"
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo bash harden-vps.sh)"
  exit 1
fi

# ─── System Updates ────────────────────────────────────────
echo ""
echo "[1/7] Updating system packages..."
apt update && apt upgrade -y

# ─── Install Required Packages ─────────────────────────────
echo ""
echo "[2/7] Installing required packages..."
apt install -y \
  ufw \
  fail2ban \
  unattended-upgrades \
  curl \
  git \
  jq

# ─── SSH Hardening ─────────────────────────────────────────
echo ""
echo "[3/7] Hardening SSH configuration..."

# Backup original config
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup.$(date +%Y%m%d)

# Apply hardened settings
cat > /etc/ssh/sshd_config.d/hardening.conf << 'EOF'
# Disable password authentication
PasswordAuthentication no
ChallengeResponseAuthentication no

# Disable root login
PermitRootLogin no

# Use only SSH protocol 2
Protocol 2

# Limit authentication attempts
MaxAuthTries 3

# Disable empty passwords
PermitEmptyPasswords no

# Disable X11 forwarding
X11Forwarding no

# Set idle timeout (5 minutes)
ClientAliveInterval 300
ClientAliveCountMax 2

# Disable TCP forwarding (unless needed)
AllowTcpForwarding no

# Log level
LogLevel VERBOSE
EOF

echo "SSH hardening config applied."

# ─── Fail2Ban Configuration ────────────────────────────────
echo ""
echo "[4/7] Configuring Fail2Ban..."

cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 3
ignoreip = 127.0.0.1/8 100.64.0.0/10

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 24h
EOF

systemctl enable fail2ban
systemctl restart fail2ban

echo "Fail2Ban configured."

# ─── Automatic Security Updates ────────────────────────────
echo ""
echo "[5/7] Enabling automatic security updates..."

cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

echo "Automatic updates enabled."

# ─── System Hardening ──────────────────────────────────────
echo ""
echo "[6/7] Applying system hardening..."

# Disable unused network protocols
cat > /etc/modprobe.d/disable-protocols.conf << 'EOF'
install dccp /bin/true
install sctp /bin/true
install rds /bin/true
install tipc /bin/true
EOF

# Kernel hardening
cat > /etc/sysctl.d/99-security.conf << 'EOF'
# IP Spoofing protection
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Ignore ICMP broadcast requests
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Disable source packet routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0

# Ignore send redirects
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# Block SYN attacks
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2
net.ipv4.tcp_syn_retries = 5

# Log Martians
net.ipv4.conf.all.log_martians = 1

# Ignore ICMP redirects
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0

# Disable IPv6 if not needed (uncomment if you don't use IPv6)
# net.ipv6.conf.all.disable_ipv6 = 1
# net.ipv6.conf.default.disable_ipv6 = 1
EOF

sysctl -p /etc/sysctl.d/99-security.conf

echo "System hardening applied."

# ─── Create Security Audit Log Directory ───────────────────
echo ""
echo "[7/7] Setting up audit logging..."

mkdir -p /var/log/prediction-mkt
chmod 750 /var/log/prediction-mkt

echo "Audit log directory created at /var/log/prediction-mkt"

# ─── Summary ───────────────────────────────────────────────
echo ""
echo "=========================================="
echo "Hardening Complete!"
echo "=========================================="
echo ""
echo "Applied:"
echo "  [x] System packages updated"
echo "  [x] SSH hardened (key-only, no root)"
echo "  [x] Fail2Ban configured"
echo "  [x] Automatic security updates enabled"
echo "  [x] Kernel hardening applied"
echo "  [x] Audit logging directory created"
echo ""
echo "Next steps:"
echo "  1. Run: sudo bash infra/setup-tailscale.sh"
echo "  2. Run: sudo bash infra/firewall-rules.sh"
echo "  3. Restart SSH: sudo systemctl restart sshd"
echo ""
echo "IMPORTANT: Before restarting SSH, ensure you have"
echo "your SSH key added to ~/.ssh/authorized_keys"
echo "=========================================="
