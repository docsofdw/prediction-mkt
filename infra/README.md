# Infrastructure Security Scripts

Scripts for hardening your VPS and setting up secure access.

## Order of Operations

```bash
# 1. SSH into your VPS first, then run these scripts in order:

# Harden the system (SSH, fail2ban, auto-updates, kernel)
sudo bash infra/harden-vps.sh

# Set up Tailscale VPN
sudo bash infra/setup-tailscale.sh
# Then run: sudo tailscale up --ssh

# Lock down firewall to Tailscale-only access
sudo bash infra/firewall-rules.sh

# Optional: Restrict outbound traffic to whitelisted domains only
sudo bash infra/outbound-whitelist.sh --enable
```

## Scripts

### harden-vps.sh
- Updates system packages
- Hardens SSH (key-only auth, no root, no password)
- Configures Fail2Ban
- Enables automatic security updates
- Applies kernel hardening (IP spoofing protection, SYN attack mitigation)

### setup-tailscale.sh
- Installs Tailscale VPN
- Configures IP forwarding
- Guides you through authentication

### firewall-rules.sh
- Configures UFW to deny all incoming traffic
- Allows SSH only from Tailscale network (100.64.0.0/10)
- Allows all traffic on Tailscale interface

### outbound-whitelist.sh
- Restricts outbound connections to only approved domains
- Blocks and logs all other outbound traffic
- Commands:
  - `--enable`: Enable whitelist
  - `--disable`: Disable whitelist
  - `--refresh`: Re-resolve DNS and update rules
  - `--status`: Show current status

## Allowed Outbound Destinations

When outbound whitelist is enabled, only these domains are allowed:
- api.anthropic.com (Claude)
- api.telegram.org (Telegram)
- gamma-api.polymarket.com (Market discovery)
- clob.polymarket.com (CLOB API)
- api.coingecko.com (BTC spot price)
- Package managers (Ubuntu, npm)
- Tailscale control plane
- GitHub (for updates)

## Cloud Firewall

For maximum security, also configure your cloud provider's firewall:
- Delete ALL inbound rules
- The VPS only needs outbound connections

This creates defense-in-depth: even if the OS firewall fails, the cloud firewall blocks all public access.

## Emergency Access

If you lose VPN access:
1. Use your cloud provider's web console
2. Restart Tailscale: `sudo systemctl restart tailscaled`
3. If needed, temporarily allow SSH: `sudo ufw allow 22/tcp`
4. Fix the issue
5. Remove the temporary rule: `sudo ufw delete allow 22/tcp`

## Related Documentation

- [VPS Setup Guide](../docs/VPS_SETUP.md) - Initial VPS configuration
- [Claim Validator System](../docs/claim-validator/README.md) - Telegram bot overview
- [Claim Validator Security](../docs/claim-validator/SECURITY.md) - Security features and audit logging
- [VPS Deployment](../docs/claim-validator/VPS_DEPLOYMENT.md) - PM2 and deployment guide
