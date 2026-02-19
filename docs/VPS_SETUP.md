# VPS Setup Guide for Polymarket Trading Bot

This guide covers setting up a VPS to run the Polymarket CLOB trading bot.

## Geographic Restrictions

Polymarket blocks trading from certain regions. Before setting up a VPS, ensure your chosen region is **not** on the blocked list.

### Blocked Countries (as of Feb 2025)

Australia, Belarus, Belgium, Burundi, Central African Republic, Congo (Kinshasa), Cuba, Ethiopia, France, Germany, Iran, Iraq, Italy, Lebanon, Libya, Myanmar, Nicaragua, North Korea, Poland, Russia, **Singapore**, Somalia, South Sudan, Sudan, Syria, Taiwan, Thailand, United Kingdom, United States, United States Minor Outlying Islands, Venezuela, Yemen, Zimbabwe

### Blocked Regions

- **Canada**: Ontario (ON)
- **Ukraine**: Crimea, Donetsk, Luhansk

### Recommended AWS Regions

| AWS Region | Location | Notes |
|------------|----------|-------|
| `ap-northeast-1` | Tokyo, Japan | Recommended |
| `ap-northeast-2` | Seoul, South Korea | Good alternative |
| `ap-south-1` | Mumbai, India | Good alternative |
| `sa-east-1` | São Paulo, Brazil | Higher latency |

## AWS Lightsail Setup

### 1. Create Instance

1. Go to AWS Lightsail Console
2. Click "Create Instance"
3. **Select region**: Tokyo (`ap-northeast-1`) or another allowed region
4. **Select platform**: Linux/Unix
5. **Select blueprint**: OS Only → Ubuntu 22.04 LTS
6. **Choose plan**: $5/mo (1 GB RAM) is sufficient for testing
7. Download the SSH key (e.g., `LightsailDefaultKey-ap-northeast-1.pem`)

### 2. Connect to Instance

```bash
# Move SSH key to proper location
cp ~/Downloads/LightsailDefaultKey-ap-northeast-1.pem ~/.ssh/
chmod 400 ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem

# Add to SSH config (~/.ssh/config)
cat >> ~/.ssh/config << 'EOF'

Host tokio
    HostName <YOUR_IP>
    User ubuntu
    IdentityFile ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem
EOF

# Connect using alias
ssh tokio
```

### 3. Install Dependencies

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Verify installation
node --version  # Should show v20.x.x
npm --version
```

### 4. Clone and Configure Project

```bash
# Clone your repository
git clone <your-repo-url> prediction-mkt
cd prediction-mkt

# Install dependencies
npm install

# Create environment file
cp .env.example .env
nano .env
```

### 5. Environment Configuration

Edit `.env` with your credentials:

```env
# Wallet (REQUIRED)
PRIVATE_KEY=your_private_key_here
FUNDER_ADDRESS=your_polymarket_funder_address

# API Credentials (derive on first run if blank)
POLY_API_KEY=
POLY_API_SECRET=
POLY_PASSPHRASE=

# Network
CHAIN_ID=137

# IMPORTANT: Set to 0 for EOA wallets (private key)
# Set to 1 only for Magic/email login wallets
SIGNATURE_TYPE=0

# Execution mode
EXECUTION_MODE=paper
```

### 6. Derive API Keys (First Time Only)

If you don't have API credentials:

```bash
npm run derive:keys
```

Copy the output values into your `.env` file.

### 7. Verify Setup

```bash
# Run diagnostics
npm run diagnose:trading

# Test order placement (requires funded wallet)
npx ts-node src/scripts/test-order.ts
```

## Wallet Requirements

Before placing orders, your wallet needs:

1. **USDC Balance**: Deposit Polygon USDC to your Polymarket account
2. **Spending Allowance**: Approve the CLOB contract to spend your USDC

You can do this via:
- Polymarket web UI (connect wallet, deposit, trade once)
- Programmatically via the SDK

## Common Errors

### 403 Forbidden: "Trading restricted in your region"

Your VPS is in a geoblocked region. Create a new instance in an allowed region (see above).

### 400 Bad Request: "not enough balance / allowance"

Your wallet needs:
- USDC deposited to Polymarket
- Spending allowance approved

### API Keys count=0

Your API credentials may be invalid or not yet derived. Run:

```bash
npm run derive:keys
```

## Running as a Service (Optional)

To keep the bot running after disconnecting:

```bash
# Using screen
screen -S polymarket
cd ~/prediction-mkt && npm run dev
# Detach: Ctrl+A, then D
# Reattach: screen -r polymarket

# Or using pm2
npm install -g pm2
pm2 start npm --name "polymarket" -- run dev
pm2 save
```

## Security Notes

- Never commit `.env` or private keys to git
- Keep SSH keys secure and use strong permissions (`chmod 400`)
- Consider using AWS Secrets Manager for production deployments
- Regularly rotate API credentials

## Related Documentation

- [Claim Validator System](./claim-validator/README.md) - Telegram bot for trading claim validation
- [Infrastructure Security](../infra/README.md) - VPS hardening and firewall scripts
- [Claim Validator VPS Deployment](./claim-validator/VPS_DEPLOYMENT.md) - Deploying the Telegram bot
