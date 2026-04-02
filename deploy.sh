#!/usr/bin/env bash
set -euo pipefail

# =============================================================
# EmailSTMP — One-shot deploy script for GCP e2-micro (Ubuntu)
# =============================================================
# Usage:
#   1. scp this whole project to the VM:
#      gcloud compute scp --recurse "C:\Users\tayom\dockerit\*" <VM_NAME>:~/emailstmp/ --zone=<ZONE>
#
#   2. SSH into the VM:
#      gcloud compute ssh <VM_NAME> --zone=<ZONE>
#
#   3. Run:
#      cd ~/emailstmp && chmod +x deploy.sh && ./deploy.sh
#
#   4. When prompted, enter your domain and .env values.
# =============================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# --- Must run as non-root (we'll use sudo where needed) ---
if [[ $EUID -eq 0 ]]; then
  err "Don't run as root. Run as your normal user — the script uses sudo where needed."
fi

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo ""
echo "========================================="
echo "  EmailSTMP Deploy Script"
echo "========================================="
echo ""

# --- Step 1: Get domain ---
read -rp "Enter your domain (e.g. mail.yourdomain.com), or press Enter to skip SSL: " DOMAIN
DOMAIN="${DOMAIN:-}"

# --- Step 2: System packages ---
log "Updating system packages..."
sudo apt update && sudo apt upgrade -y

log "Installing dependencies..."
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx

# --- Step 3: Firewall ---
log "Configuring firewall..."
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
echo "y" | sudo ufw enable || true
log "Firewall configured."

# --- Step 4: Docker ---
if command -v docker &>/dev/null; then
  log "Docker already installed: $(docker --version)"
else
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  warn "Docker group added. If 'docker compose' fails below, log out and back in, then re-run this script."
fi

# Make sure we can run docker (might need newgrp)
if ! docker info &>/dev/null; then
  log "Activating docker group for this session..."
  sg docker -c "docker info" &>/dev/null || warn "Docker permission issue — you may need to log out and back in."
fi

# --- Step 5: Swap (safety net for 1 GB RAM) ---
if [[ ! -f /swapfile ]]; then
  log "Creating 1 GB swap file..."
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
  log "Swap enabled."
else
  log "Swap already exists."
fi

# --- Step 6: .env setup ---
if [[ ! -f .env ]]; then
  log "Setting up .env file..."
  API_KEY=$(openssl rand -hex 32)

  read -rp "ALLOWED_ORIGINS (comma-separated, e.g. https://yourapp.com), or press Enter for *: " ALLOWED_ORIGINS
  ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-*}"

  cat > .env <<EOF
NODE_ENV=production
PORT=3000

API_KEY=${API_KEY}

ALLOWED_ORIGINS=${ALLOWED_ORIGINS}

RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=100
MAX_PER_BATCH=50
MAX_CONCURRENT_BATCHES=5
EOF

  chmod 600 .env
  log ".env created. Your API_KEY is:"
  echo ""
  echo "  $API_KEY"
  echo ""
  warn "Save this key — you'll need it to authenticate API requests."
else
  log ".env already exists — skipping."
fi

# --- Step 7: Build and start the app ---
log "Building and starting the container..."
sg docker -c "docker compose up -d --build" 2>/dev/null || docker compose up -d --build

log "Waiting for container to be healthy..."
sleep 10

# Quick health check
if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
  log "App is running and healthy!"
else
  warn "App may still be starting. Check with: docker compose logs -f"
fi

# --- Step 8: Nginx ---
if [[ -n "$DOMAIN" ]]; then
  log "Configuring Nginx for $DOMAIN..."

  # Add rate limit zone to main nginx.conf (http context)
  if ! grep -q 'emailstmp_api' /etc/nginx/nginx.conf; then
    sudo sed -i '/http {/a \\n    limit_req_zone \$binary_remote_addr zone=emailstmp_api:10m rate=10r/s;' /etc/nginx/nginx.conf
  fi

  # Start with HTTP-only config (needed for Certbot)
  sudo tee /etc/nginx/sites-available/emailstmp > /dev/null <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    server_tokens off;

    limit_req zone=emailstmp_api burst=20 nodelay;
    limit_req_status 429;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 30s;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /health {
        proxy_pass http://localhost:3000/api/health;
        proxy_set_header Host            \$host;
        proxy_set_header X-Real-IP       \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        access_log off;
    }
}
NGINX

  sudo ln -sf /etc/nginx/sites-available/emailstmp /etc/nginx/sites-enabled/emailstmp
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl reload nginx
  log "Nginx configured (HTTP)."

  # SSL with Certbot
  log "Requesting SSL certificate..."
  echo ""
  warn "Make sure your domain's A record points to this VM's external IP BEFORE continuing."
  read -rp "Press Enter when DNS is ready (or type 'skip' to skip SSL): " SSL_CONFIRM

  if [[ "$SSL_CONFIRM" != "skip" ]]; then
    sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email || {
      warn "Certbot failed — you can run it manually later: sudo certbot --nginx -d $DOMAIN"
    }
    sudo certbot renew --dry-run || true
    log "SSL configured!"
  else
    warn "SSL skipped. Run later: sudo certbot --nginx -d $DOMAIN"
  fi
else
  log "No domain provided — Nginx configured for direct IP access on port 80."

  # Add rate limit zone to main nginx.conf (http context)
  if ! grep -q 'emailstmp_api' /etc/nginx/nginx.conf; then
    sudo sed -i '/http {/a \\n    limit_req_zone \$binary_remote_addr zone=emailstmp_api:10m rate=10r/s;' /etc/nginx/nginx.conf
  fi

  sudo tee /etc/nginx/sites-available/emailstmp > /dev/null <<NGINX
server {
    listen 80 default_server;
    server_name _;
    server_tokens off;

    limit_req zone=emailstmp_api burst=20 nodelay;
    limit_req_status 429;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 30s;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /health {
        proxy_pass http://localhost:3000/api/health;
        proxy_set_header Host            \$host;
        proxy_set_header X-Real-IP       \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        access_log off;
    }
}
NGINX

  sudo ln -sf /etc/nginx/sites-available/emailstmp /etc/nginx/sites-enabled/emailstmp
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl reload nginx
fi

# --- Step 9: Auto-restart on reboot ---
sudo systemctl enable docker
sudo systemctl enable nginx

# --- Done ---
echo ""
echo "========================================="
log "Deployment complete!"
echo "========================================="
echo ""
if [[ -n "$DOMAIN" ]]; then
  echo "  Health check:  curl https://${DOMAIN}/api/health"
else
  echo "  Health check:  curl http://<YOUR_VM_IP>/api/health"
fi
echo ""
echo "  Useful commands:"
echo "    docker compose logs -f       # App logs"
echo "    docker compose ps            # Container status"
echo "    docker compose up -d --build # Redeploy after changes"
echo ""
