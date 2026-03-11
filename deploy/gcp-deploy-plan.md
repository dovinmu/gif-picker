# Honeycomb GCP Deployment Plan

VM: `honeycomb` (e2-standard-2, 8GB RAM, 30GB disk, Ubuntu 24.04)
Zone: `us-west1-c` (default zone)
IP: `34.169.80.70`
Status: **Created, SSH verified, not yet configured**

## 1. Prepare the VM

```bash
gcloud compute ssh honeycomb

# Update packages
sudo apt update && sudo apt upgrade -y

# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# Install Node.js (for building frontend on VM) — or build locally and scp dist/
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm
```

## 2. Get antfly binary onto the VM

Option A: SCP a pre-built binary
```bash
# From local machine — wherever the antfly binary is
gcloud compute scp /path/to/antfly honeycomb:~/antfly --zone=us-west1-c
```

Option B: Build on VM (requires Go)
```bash
# On VM
sudo snap install go --classic
git clone <antfly-repo> ~/antfly-repo
cd ~/antfly-repo && go build -o ~/antfly ./cmd/antfly
```

## 3. Get the termite embedding model

Antfly needs termite for query-time embedding (semantic search). The embedding model (BAAI/bge-small-en-v1.5) is tiny (~130MB) and runs fine on CPU.

```bash
# Get termite binary onto the VM (same as antfly — scp or build)
gcloud compute scp /path/to/termite honeycomb:~/termite --zone=us-west1-c

# Pull the embedding model
./termite pull BAAI/bge-small-en-v1.5 --type embedder
```

**Question to resolve:** Does antfly embed queries at search time via termite, or are embeddings fully pre-computed? If pre-computed, termite isn't needed on the serving VM.

## 4. Package and upload the database

```bash
# From local machine — package the pebble database
tar -czf /tmp/antfly-db.tar.gz -C ~ .antfly

# Upload to VM
gcloud compute scp /tmp/antfly-db.tar.gz honeycomb:~ --zone=us-west1-c

# On VM — extract
cd ~ && tar -xzf antfly-db.tar.gz && rm antfly-db.tar.gz
```

## 5. Clone the repo and build frontend

```bash
# On VM
git clone <gif-picker-repo> ~/gif-picker
cd ~/gif-picker/web
pnpm install && pnpm build

# Deploy static files
sudo mkdir -p /var/www/honeycomb
sudo cp -r dist/* /var/www/honeycomb/
```

Alternative: build locally and scp just the dist:
```bash
# Local
cd /Users/rowan/Documents/antfly/gif-picker && make web-build
gcloud compute scp --recurse web/dist honeycomb:~/honeycomb-dist --zone=us-west1-c

# On VM
sudo mkdir -p /var/www/honeycomb
sudo cp -r ~/honeycomb-dist/* /var/www/honeycomb/
```

## 6. Configure services

### antfly.service

```bash
# Copy and adapt the existing service file
# Key: update User, paths, and add R2 env vars
sudo tee /etc/systemd/system/antfly.service << 'EOF'
[Unit]
Description=Antfly vector database
After=network.target

[Service]
Type=simple
User=rowan
WorkingDirectory=/home/rowan
ExecStart=/home/rowan/antfly swarm --config /home/rowan/gif-picker/config.yaml
Restart=on-failure
RestartSec=5
Environment=HOME=/home/rowan
EnvironmentFile=/home/rowan/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable antfly
sudo systemctl start antfly
```

**Note:** config.yaml references `User=ubuntu` paths — need to update to `rowan` (or whatever the GCE user ends up being). Also need `/home/rowan/.env` with R2 credentials.

### Caddyfile

```bash
# Update domain and deploy
sudo tee /etc/caddy/Caddyfile << 'EOF'
honeycomb.rowan.earth {
    handle /api/* {
        reverse_proxy localhost:8080
    }

    handle {
        root * /var/www/honeycomb
        try_files {path} /index.html
        file_server
    }

    encode gzip

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
EOF

sudo systemctl reload caddy
```

## 7. DNS cutover

Point `honeycomb.rowan.earth` to `34.169.80.70` (current VM IP).

**Option:** Use a static IP so it survives VM restarts:
```bash
gcloud compute addresses create honeycomb-ip --region=us-west1
gcloud compute instances delete-access-config honeycomb --zone=us-west1-c --access-config-name="External NAT"
gcloud compute instances add-access-config honeycomb --zone=us-west1-c --address=<STATIC_IP>
```

Or just update DNS each time (ephemeral IP changes on stop/start).

## 8. Verify

```bash
# On VM
curl http://localhost:8080/api/v1/tables
curl https://honeycomb.rowan.earth

# From local
curl https://honeycomb.rowan.earth/api/v1/tables
```

## Open questions

- [ ] Where is the antfly binary? Need path to scp it, or repo URL to build on VM.
- [ ] Does antfly need termite running for search queries? (query-time embedding vs pre-computed)
- [ ] Update `config.yaml` paths from `/home/ubuntu` to match GCE username (`rowan`)
- [ ] R2 credentials — need `.env` file on the VM
- [ ] Static IP or ephemeral? (static adds ~$3/mo)
- [ ] Do we need the termite proxy route in Caddy, or is that only for the inference pipeline?
- [ ] The `admin.honeycomb.example.com` subdomain from the original Caddyfile — do we want that?
