# EmailSTMP — Google Cloud Deployment Guide

Deploy the Dockerized EmailSTMP microservice on a Google Cloud Compute Engine VM with Nginx + SSL.

---

## 1. Create the VM

In the [Google Cloud Console](https://console.cloud.google.com/compute/instances):

1. **Create Instance**
   - Name: `emailstmp`
   - Region: pick one close to your users (e.g. `us-central1`)
   - Machine type: **e2-small** (2 vCPU, 2 GB RAM) — plenty for an SMTP relay
   - Boot disk: **Ubuntu 24.04 LTS**, 20 GB SSD
   - Firewall: ✅ Allow HTTP traffic, ✅ Allow HTTPS traffic

2. Click **Create** and wait for the VM to start.

3. Note the **External IP** — you'll point your domain here.

4. **Point your domain's A record** at the External IP before proceeding (Certbot needs it).

---

## 2. SSH Into the VM

Click **SSH** in the Console, or from your terminal:

```bash
gcloud compute ssh emailstmp --zone=us-central1-a
```

---

## 3. System Setup

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx
```

### Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

---

## 4. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Log out and back in for group change to take effect
exit
# SSH back in
```

Verify:

```bash
docker --version
docker compose version
```

---

## 5. Deploy the App

### 5a. Copy files to the server

From your **local machine** (PowerShell):

```powershell
# Option A: Use gcloud scp
gcloud compute scp --recurse "C:\Users\tayom\dockerit\*" emailstmp:~/emailstmp/ --zone=us-central1-a

# Option B: If using a Git repo, clone on the server instead:
# git clone https://github.com/YourOrg/EmailSTMP.git ~/emailstmp
```

### 5b. Create the production .env

```bash
cd ~/emailstmp
cp .env.example .env
nano .env
```

Set these values:

```env
NODE_ENV=production
PORT=3000

# Generate a real key: openssl rand -hex 32
API_KEY=<your-64-char-hex-key>

# Your SMTP provider credentials
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=you@yourdomain.com
SMTP_PASS=your-smtp-password

# The domain(s) your cold email app will call from
ALLOWED_ORIGINS=https://yourapp.com

RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=100
MAX_PER_BATCH=50
MAX_CONCURRENT_BATCHES=5
```

Lock it down:

```bash
chmod 600 .env
```

### 5c. Build and start

```bash
cd ~/emailstmp
docker compose up -d --build

# Watch logs
docker compose logs -f

# Confirm healthy (~30 seconds)
docker compose ps
```

---

## 6. Configure Nginx + SSL

### 6a. Set up the site config

```bash
# Replace example.com with your actual domain
sudo sed 's/example.com/yourdomain.com/g' ~/emailstmp/nginx.conf \
  | sudo tee /etc/nginx/sites-available/emailstmp

sudo ln -sf /etc/nginx/sites-available/emailstmp /etc/nginx/sites-enabled/emailstmp
sudo rm -f /etc/nginx/sites-enabled/default
```

### 6b. Get SSL certificate

```bash
# Temporarily comment out the SSL block — start with HTTP only
sudo systemctl start nginx
sudo certbot --nginx -d yourdomain.com

# Verify auto-renewal
sudo certbot renew --dry-run
```

### 6c. Reload Nginx

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 7. Verify

```bash
# Health check
curl -sf https://yourdomain.com/api/health
# → {"status":"ok","timestamp":"..."}

# Container health
docker inspect --format='{{.State.Health.Status}}' emailstmp-emailstmp-1
# → healthy

# HTTP → HTTPS redirect
curl -I http://yourdomain.com/
# → 301 to https://
```

---

## 8. Connect Your App

From your cold email app, send emails like this:

```javascript
const response = await fetch('https://yourdomain.com/api/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'your-64-char-api-key',
  },
  body: JSON.stringify({
    smtp: {
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: 'you@gmail.com', pass: 'app-password' },
    },
    email: {
      from: 'you@gmail.com',
      to: 'lead@example.com',
      subject: 'Quick question',
      text: 'Hey, wanted to reach out...',
    },
  }),
});
```

---

## 9. Ongoing Operations

### Redeploy after code changes

```bash
cd ~/emailstmp
git pull   # or scp new files
docker compose up -d --build
```

### View logs

```bash
docker compose logs -f                         # App logs
sudo tail -f /var/log/nginx/access.log         # Nginx logs
```

### Auto-restart on reboot

```bash
sudo systemctl enable docker
```

---

## Cost Estimate

| Resource | Monthly Cost |
|----------|-------------|
| e2-small VM (2 vCPU, 2 GB) | ~$13 |
| 20 GB SSD | ~$2 |
| Static IP (while attached) | Free |
| **Total** | **~$15/mo** |

> **Tip:** If you want to save money, an **e2-micro** (free tier eligible) works too — it's just tighter on RAM (1 GB).
