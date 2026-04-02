# EmailSTMP — Production Deployment Guide (Hetzner VPS)

Target: Hetzner CX22, Ubuntu 24.04 LTS, Node 20 API behind Nginx with Let's Encrypt SSL.

---

## 1. Provision the Server

In the Hetzner Cloud console:

1. Create a new server — type **CX22** (2 vCPU, 4 GB RAM), image **Ubuntu 24.04**.
2. Add your SSH public key during provisioning.
3. Note the public IPv4 address.
4. Point your domain's A record at that IP before proceeding (Certbot needs it to resolve).

SSH in as root:

```bash
ssh root@<YOUR_SERVER_IP>
```

---

## 2. System Preparation

```bash
apt update && apt upgrade -y
apt install -y curl git ufw

# Firewall — allow SSH, HTTP, HTTPS only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

---

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sh

# Verify
docker --version
docker compose version
```

---

## 4. Install Nginx and Certbot

```bash
apt install -y nginx certbot python3-certbot-nginx

# Stop Nginx temporarily so Certbot's standalone mode can bind port 80
systemctl stop nginx
```

---

## 5. Deploy the Application

### 5a. Copy the repository to the server

Option A — clone from a private/public repo:

```bash
git clone https://github.com/YOUR_ORG/EmailSTMP.git /opt/emailstmp
```

Option B — rsync from your local machine (run this locally):

```bash
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' \
  /Users/juniper/EmailSTMP/ root@<YOUR_SERVER_IP>:/opt/emailstmp/
```

### 5b. Create the production .env file

```bash
cd /opt/emailstmp
cp .env.example .env
nano .env   # or: vim .env
```

Required variables (check .env.example for the full list):

```
NODE_ENV=production
PORT=3000

# SMTP credentials for the relay account
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=relay@example.com
SMTP_PASS=your_smtp_password

# Add any other required vars from .env.example
```

Lock down the file:

```bash
chmod 600 .env
```

### 5c. Build and start the container

```bash
cd /opt/emailstmp
docker compose up -d --build

# Watch logs
docker compose logs -f

# Confirm container is healthy (status should show "healthy" after ~30s)
docker compose ps
```

---

## 6. Configure Nginx

### 6a. Install the site config

```bash
# Replace 'example.com' with your actual domain in nginx.conf first
sed -i 's/example.com/yourdomain.com/g' /opt/emailstmp/nginx.conf

cp /opt/emailstmp/nginx.conf /etc/nginx/sites-available/emailstmp
ln -s /etc/nginx/sites-available/emailstmp /etc/nginx/sites-enabled/emailstmp

# Remove the default site if present
rm -f /etc/nginx/sites-enabled/default

# Syntax check before starting
nginx -t
```

### 6b. Temporarily serve HTTP only to allow Certbot to issue the certificate

Comment out the ssl_certificate lines in /etc/nginx/sites-available/emailstmp and change the
443 block to listen on 80, OR use Certbot's standalone mode (simpler):

```bash
# Start Nginx with a plain HTTP config for now
# (Certbot --nginx plugin will handle the SSL injection in the next step)
systemctl start nginx
```

---

## 7. Obtain SSL Certificate via Certbot

```bash
certbot --nginx -d yourdomain.com

# Follow the prompts — Certbot will:
#   1. Verify domain ownership over HTTP
#   2. Issue the certificate
#   3. Automatically edit your Nginx config to add SSL directives

# Confirm auto-renewal works
certbot renew --dry-run
```

After Certbot runs, verify it updated /etc/nginx/sites-available/emailstmp with the correct
certificate paths, then reload:

```bash
nginx -t && systemctl reload nginx
```

Alternatively, if you placed the nginx.conf manually with the Let's Encrypt paths already set:

```bash
# Paths Certbot writes to:
# /etc/letsencrypt/live/yourdomain.com/fullchain.pem
# /etc/letsencrypt/live/yourdomain.com/privkey.pem
```

---

## 8. Verify the Deployment

```bash
# Health endpoint via HTTPS
curl -sf https://yourdomain.com/health

# Expected: HTTP 200, JSON body with status ok (or similar)

# Check container health status
docker inspect --format='{{.State.Health.Status}}' emailstmp-emailstmp-1

# Check Nginx is proxying correctly
curl -I https://yourdomain.com/

# Confirm HTTP redirects to HTTPS
curl -I http://yourdomain.com/
# Expected: 301 redirect to https://
```

---

## 9. Ongoing Operations

### View logs

```bash
# Application logs
docker compose -f /opt/emailstmp/docker-compose.yml logs -f

# Nginx access/error logs
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

### Redeploy after a code change

```bash
cd /opt/emailstmp
git pull          # or rsync from local
docker compose up -d --build
```

Docker Compose will rebuild the image and restart the container with zero manual downtime
(the old container serves traffic until the new one passes its health check).

### Certificate renewal

Certbot installs a systemd timer that runs `certbot renew` twice daily automatically.
Check its status:

```bash
systemctl status certbot.timer
```

### Container auto-restart

The `restart: unless-stopped` policy in docker-compose.yml means the container restarts
automatically on crash or after a server reboot. To confirm Docker itself starts on boot:

```bash
systemctl enable docker
```

---

## File Reference

| File | Purpose |
|------|---------|
| `Dockerfile` | Two-stage build; runs as non-root `appuser`; includes HEALTHCHECK |
| `docker-compose.yml` | Local testing and production container management |
| `nginx.conf` | Reverse proxy with SSL, rate limiting, and security headers |
| `.dockerignore` | Excludes secrets, logs, coverage output from the image |
| `DEPLOY.md` | This file |
