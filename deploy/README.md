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
# Build locally
cd web
npm install
npm run build

# Transfer to server
rsync -avz dist/ user@server:/var/www/honeycomb/

# Or on server if you have the repo there
cd gif-picker/web
npm install
npm run build
sudo cp -r dist/* /var/www/honeycomb/
```

## 5. Configure Caddy

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
cd gif-picker/web
npm run build
sudo cp -r dist/* /var/www/honeycomb/
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
curl http://localhost:8080/api/v1/tables
```

### Test termite directly

```bash
curl http://localhost:11434/api/tags
```
