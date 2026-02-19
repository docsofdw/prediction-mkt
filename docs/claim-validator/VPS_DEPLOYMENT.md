# VPS Deployment Guide

This guide covers deploying the Telegram bot to your VPS with proper security and auto-restart configuration.

## Prerequisites

- VPS with Ubuntu 22.04 (see [../VPS_SETUP.md](../VPS_SETUP.md))
- Node.js 20+ installed on VPS
- Tailscale VPN configured (see [../../infra/README.md](../../infra/README.md))
- PM2 installed globally: `npm install -g pm2`

## Current Infrastructure

| Component | Value |
|-----------|-------|
| VPS Provider | AWS Lightsail |
| Region | Tokyo (ap-northeast-1) |
| Instance | $5/mo (512MB RAM + 1GB swap) |
| Public IP | 54.248.145.165 |
| Tailscale IP | 100.64.97.50 |
| Local Tailscale | 100.68.16.22 |
| PM2 Startup | Enabled (survives reboots) |
| Cron | 9am UTC daily maker scan |

## Deployment Steps

### 1. Build Locally

The VPS has limited RAM (416MB available), so we build locally and sync compiled JS:

```bash
# On local machine
cd ~/development/prediction-mkt
npm run build
```

### 2. Sync to VPS

```bash
# Sync dist folder and package files
rsync -avz --delete \
  dist/ \
  package.json \
  package-lock.json \
  config/ \
  .env \
  ubuntu@100.64.97.50:~/prediction-mkt/

# SSH and install production deps
ssh ubuntu@100.64.97.50
cd ~/prediction-mkt
npm install --production
```

### 3. Start with PM2

```bash
# Start the bot
pm2 start node --name telegram-bot -- dist/telegram-bot/index.js

# Verify it's running
pm2 list
pm2 logs telegram-bot
```

### 4. Configure Auto-Restart

```bash
# Generate systemd startup script
pm2 startup systemd -u ubuntu --hp /home/ubuntu

# Run the command it outputs (starts with sudo env PATH=...)
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu

# Save the process list
pm2 save
```

### 5. Verify Auto-Restart

```bash
# Reboot the VPS
sudo reboot

# After reboot, check if bot came back up
pm2 list
```

## PM2 Commands Reference

```bash
# View running processes
pm2 list

# View logs (real-time)
pm2 logs telegram-bot

# View last 100 lines
pm2 logs telegram-bot --lines 100

# Restart the bot
pm2 restart telegram-bot

# Stop the bot
pm2 stop telegram-bot

# Delete from PM2
pm2 delete telegram-bot

# Monitor resources
pm2 monit
```

## Cron Tasks

### Maker Longshot Scanner

Daily automated scans for maker opportunities, sends smart notifications to Telegram:

```bash
# View current cron
crontab -l

# Edit cron
crontab -e

# Add this line (9am UTC daily):
0 9 * * * cd ~/prediction-mkt && /usr/bin/npm run maker:notify >> ~/logs/maker-cron.log 2>&1
```

**Smart notifications only trigger when:**
- 🆕 New markets found
- 📈 Price changed >10%
- 📅 Weekly digest (no changes for 7 days)

**Check logs:**
```bash
# View recent cron output
tail -50 ~/logs/maker-cron.log

# Check state file
cat ~/prediction-mkt/backtests/maker-scan-state.json
```

**Force notification (testing):**
```bash
cd ~/prediction-mkt && npm run maker:notify -- --force
```

### Setting Up Cron Log Directory

```bash
mkdir -p ~/logs
```

## Memory Optimization

The VPS has limited RAM (512MB). Key optimizations:

1. **Swap space**: 1GB swap file prevents OOM kills during npm install
2. **No ts-node**: We compile TypeScript locally and run plain Node.js
3. **Production deps only**: `npm install --production` skips devDependencies
4. **Single process**: No PM2 cluster mode

**Swap setup (already configured):**
```bash
# Check swap
free -h

# If not set up:
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Current memory usage: ~66MB (well within limits)

## Updating the Bot

```bash
# On local machine
cd ~/development/prediction-mkt

# Make changes, then build
npm run build

# Sync to VPS
rsync -avz --delete dist/ ubuntu@100.64.97.50:~/prediction-mkt/dist/

# Restart on VPS
ssh ubuntu@100.64.97.50 "pm2 restart telegram-bot"
```

Or as a one-liner:
```bash
npm run build && rsync -avz --delete dist/ ubuntu@100.64.97.50:~/prediction-mkt/dist/ && ssh ubuntu@100.64.97.50 "pm2 restart telegram-bot"
```

## SSH Configuration

Add to `~/.ssh/config` for easier access:

```
Host polymarket-vps
    HostName 100.64.97.50
    User ubuntu
    IdentityFile ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem

# Alias for Tailscale access
Host tokyo-tailscale
    HostName 100.64.97.50
    User ubuntu
```

Then connect with:
```bash
ssh polymarket-vps
# or
ssh tokyo-tailscale
```

## Troubleshooting

### Bot Not Starting

```bash
# Check PM2 logs for errors
pm2 logs telegram-bot --err

# Check if .env exists
ls -la ~/prediction-mkt/.env

# Test manually
cd ~/prediction-mkt
node dist/telegram-bot/index.js
```

### Memory Issues (OOM Kill)

```bash
# Check memory usage
free -h

# Check if process was killed
dmesg | grep -i "killed process"

# Reduce PM2 overhead
pm2 delete all
pm2 start node --name telegram-bot -- dist/telegram-bot/index.js
```

### SSH Connection Issues

```bash
# Use Tailscale IP instead of public IP
ssh ubuntu@100.64.97.50

# If Tailscale is down, use AWS console to:
# 1. Connect via browser-based SSH
# 2. Restart Tailscale: sudo systemctl restart tailscaled
# 3. Re-authenticate: sudo tailscale up
```

### Bot Running But Not Responding

```bash
# Check if polling is working
pm2 logs telegram-bot

# Restart the bot
pm2 restart telegram-bot

# Check Telegram API status
curl -s "https://api.telegram.org/bot<TOKEN>/getMe"
```

## Security Hardening (Optional)

After deployment is stable, apply additional hardening:

```bash
# SSH into VPS
ssh ubuntu@100.64.97.50

# Lock firewall to Tailscale only
sudo bash infra/firewall-rules.sh

# Restrict outbound traffic (optional, may break things)
sudo bash infra/outbound-whitelist.sh --enable
```

See [../../infra/README.md](../../infra/README.md) for details.

## Logs Location

| Log | Location |
|-----|----------|
| PM2 logs | `~/.pm2/logs/telegram-bot-*.log` |
| Audit log | `~/prediction-mkt/config/audit-log.jsonl` |
| System | `/var/log/syslog` |
