# Honeycomb Deployment

## Prerequisites

- Ubuntu/Debian VM with sudo access
- Domain pointing to VM IP
- Antfly binary installed at `/usr/local/bin/antfly`
- Node.js 18+ (for building frontend)

## 1. Install Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

## 2. Deploy Antfly database

Transfer your local `~/.antfly` directory to the server:

```bash
# From local machine
tar -czf antfly-db.tar.gz -C ~ .antfly
scp antfly-db.tar.gz user@server:/tmp/

# On server
tar -xzf /tmp/antfly-db.tar.gz -C ~
```

## 3. Set up Antfly service

```bash
# Copy service file
sudo cp antfly.service /etc/systemd/system/

# Edit if needed (change User, paths)
sudo nano /etc/systemd/system/antfly.service

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable antfly
sudo systemctl start antfly

# Check status
sudo systemctl status antfly
journalctl -u antfly -f
```

## 4. Build and deploy frontend

```bash
# Install pnpm
npm install -g pnpm

# Build locally
cd gif-picker
make web-build

# Transfer to server
rsync -avz web/dist/ user@server:/var/www/honeycomb/

# Or on server if you have the repo there
cd gif-picker
make web-build
sudo cp -r web/dist/* /var/www/honeycomb/
```

## 5. Configure Caddy

Caddy serves the frontend and forwards the one API call Honeycomb makes
(`POST /db/v1/tables/honeycomb/query`) to Antfly Cloud, adding the API key.
Give Caddy the instance ID and a key that can query the `honeycomb` table:

```bash
sudo systemctl edit caddy
# [Service]
# Environment=ANTFLY_CLOUD_INSTANCE=<instance-id>
# Environment=ANTFLY_API_KEY=<key>
```

Use a key with explicit grants (read on `honeycomb`) and no expiry: Colony
revokes instance keys without explicit grants, and expiring keys, when its
key migrations 136/137 run.

```bash
# Edit Caddyfile - replace domain
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile

# Reload Caddy (auto-provisions TLS)
sudo systemctl reload caddy

# Check status
sudo systemctl status caddy
```

## Updating

### Update frontend only

```bash
# On VM (honeycomb, us-west1-c)
cd ~/gif-picker && git pull
cd web && pnpm install && pnpm build
sudo cp -r dist/* /var/www/honeycomb/
```

Or from your local machine:

```bash
gcloud compute ssh honeycomb --zone=us-west1-c --command="
  cd ~/gif-picker && git pull && cd web && pnpm install && pnpm build &&
  sudo cp -r dist/* /var/www/honeycomb/
"
```

### Update database

```bash
# Stop antfly
sudo systemctl stop antfly

# Replace database
rm -rf ~/.antfly
tar -xzf /tmp/antfly-db.tar.gz -C ~

# Restart
sudo systemctl start antfly
```

## Troubleshooting

### Check services

```bash
sudo systemctl status antfly
sudo systemctl status caddy
```

### View logs

```bash
# Antfly logs
journalctl -u antfly -f

# Caddy logs
journalctl -u caddy -f
```

### Test API directly

```bash
# Through Caddy (what the browser uses)
curl -X POST -H 'Content-Type: application/json' -d '{"limit":1}' \
  http://localhost/db/v1/tables/honeycomb/query

# A local Antfly v0.3 serves its data API under /db/v1
curl http://localhost:8080/db/v1/tables
```

### Test termite directly

```bash
curl http://localhost:11434/api/tags
```
