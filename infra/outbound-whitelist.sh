#!/bin/bash
# Outbound Traffic Whitelist Script
# Restricts outbound connections to only required endpoints
# Usage: sudo bash outbound-whitelist.sh [--enable|--disable|--status]

set -e

# ─── Configuration ─────────────────────────────────────────
# Allowed outbound destinations for the prediction market bot

ALLOWED_DOMAINS=(
  # Anthropic API (Claude)
  "api.anthropic.com"

  # Telegram API
  "api.telegram.org"

  # Polymarket APIs
  "gamma-api.polymarket.com"
  "clob.polymarket.com"
  "strapi-matic.poly.market"

  # CoinGecko (BTC spot price)
  "api.coingecko.com"

  # Package managers (for updates)
  "archive.ubuntu.com"
  "security.ubuntu.com"
  "deb.nodesource.com"
  "registry.npmjs.org"

  # Tailscale
  "controlplane.tailscale.com"
  "login.tailscale.com"

  # GitHub (for OpenClaw updates if needed)
  "github.com"
  "api.github.com"

  # DNS
  "1.1.1.1"
  "8.8.8.8"
)

# ─── Functions ─────────────────────────────────────────────

resolve_ip() {
  local domain=$1
  # Get all IPs for domain
  dig +short "$domain" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || echo ""
}

show_status() {
  echo "=========================================="
  echo "Outbound Whitelist Status"
  echo "=========================================="

  if iptables -L OUTPUT -n | grep -q "OUTBOUND_WHITELIST"; then
    echo "Status: ENABLED"
    echo ""
    echo "Allowed destinations:"
    iptables -L OUTBOUND_WHITELIST -n 2>/dev/null | grep ACCEPT | awk '{print "  " $4}'
  else
    echo "Status: DISABLED (all outbound allowed)"
  fi
}

enable_whitelist() {
  echo "=========================================="
  echo "Enabling Outbound Whitelist"
  echo "=========================================="

  # Check if running as root
  if [ "$EUID" -ne 0 ]; then
    echo "Please run as root"
    exit 1
  fi

  # Remove existing chain if present
  iptables -D OUTPUT -j OUTBOUND_WHITELIST 2>/dev/null || true
  iptables -F OUTBOUND_WHITELIST 2>/dev/null || true
  iptables -X OUTBOUND_WHITELIST 2>/dev/null || true

  # Create new chain
  iptables -N OUTBOUND_WHITELIST

  # Allow established connections
  iptables -A OUTBOUND_WHITELIST -m state --state ESTABLISHED,RELATED -j ACCEPT

  # Allow loopback
  iptables -A OUTBOUND_WHITELIST -o lo -j ACCEPT

  # Allow Tailscale interface
  iptables -A OUTBOUND_WHITELIST -o tailscale0 -j ACCEPT

  # Allow DNS (needed for resolution)
  iptables -A OUTBOUND_WHITELIST -p udp --dport 53 -j ACCEPT
  iptables -A OUTBOUND_WHITELIST -p tcp --dport 53 -j ACCEPT

  # Allow HTTPS to whitelisted domains
  echo ""
  echo "Resolving and whitelisting domains..."

  for domain in "${ALLOWED_DOMAINS[@]}"; do
    echo "  Adding: $domain"

    # Get IPs for domain
    ips=$(resolve_ip "$domain")

    if [ -n "$ips" ]; then
      for ip in $ips; do
        iptables -A OUTBOUND_WHITELIST -d "$ip" -p tcp --dport 443 -j ACCEPT
        iptables -A OUTBOUND_WHITELIST -d "$ip" -p tcp --dport 80 -j ACCEPT
      done
    else
      echo "    Warning: Could not resolve $domain"
    fi
  done

  # Log and drop everything else
  iptables -A OUTBOUND_WHITELIST -j LOG --log-prefix "OUTBOUND_BLOCKED: " --log-level 4
  iptables -A OUTBOUND_WHITELIST -j DROP

  # Apply chain to OUTPUT
  iptables -A OUTPUT -j OUTBOUND_WHITELIST

  # Save rules
  if command -v netfilter-persistent &>/dev/null; then
    netfilter-persistent save
  elif command -v iptables-save &>/dev/null; then
    iptables-save > /etc/iptables.rules
    echo "Rules saved to /etc/iptables.rules"
    echo "Add to /etc/rc.local: iptables-restore < /etc/iptables.rules"
  fi

  echo ""
  echo "Outbound whitelist ENABLED."
  echo ""
  echo "Blocked connections will be logged to /var/log/syslog"
  echo "Search with: grep OUTBOUND_BLOCKED /var/log/syslog"
}

disable_whitelist() {
  echo "=========================================="
  echo "Disabling Outbound Whitelist"
  echo "=========================================="

  # Check if running as root
  if [ "$EUID" -ne 0 ]; then
    echo "Please run as root"
    exit 1
  fi

  # Remove chain
  iptables -D OUTPUT -j OUTBOUND_WHITELIST 2>/dev/null || true
  iptables -F OUTBOUND_WHITELIST 2>/dev/null || true
  iptables -X OUTBOUND_WHITELIST 2>/dev/null || true

  echo "Outbound whitelist DISABLED."
  echo "All outbound traffic is now allowed."
}

refresh_whitelist() {
  echo "=========================================="
  echo "Refreshing Outbound Whitelist"
  echo "=========================================="
  echo "(Re-resolving DNS for all domains)"

  disable_whitelist
  enable_whitelist
}

# ─── Main ──────────────────────────────────────────────────

case "${1:-status}" in
  --enable|-e)
    enable_whitelist
    ;;
  --disable|-d)
    disable_whitelist
    ;;
  --refresh|-r)
    refresh_whitelist
    ;;
  --status|-s|status)
    show_status
    ;;
  *)
    echo "Usage: $0 [--enable|--disable|--refresh|--status]"
    echo ""
    echo "  --enable   Enable outbound whitelist (block non-whitelisted)"
    echo "  --disable  Disable whitelist (allow all outbound)"
    echo "  --refresh  Re-resolve DNS and update rules"
    echo "  --status   Show current status"
    exit 1
    ;;
esac
