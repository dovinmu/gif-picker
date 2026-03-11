# Antfly & Termite on GCE

Guide for deploying Antfly (vector database) and Termite (ML inference) on Google Compute Engine. Covers both production serving (antfly + embedded termite for search) and batch inference (standalone termite with generative models). Written from hard-won experience deploying the Honeycomb GIF picker.

> **User-specific items** are marked with `<!-- CUSTOMIZE -->` throughout this document. Search for that tag to find everything you need to change for your own deployment.

---

## Part 1: Deploying Antfly for Production Serving

This section covers deploying antfly-omni as a production vector database with semantic search, fronted by Caddy with auto-TLS.

### Architecture

```
Internet → Caddy (auto-TLS) → :8080 antfly swarm
                                  ├── metadata server
                                  ├── store server (pebble LSM)
                                  └── embedded termite (embeddings)
                                       └── bge-small-en-v1.5 (384-dim, ~128MB)
```

Antfly runs in **swarm mode** (single-node, no raft consensus) with embedded termite for query-time embedding. Media files (GIFs, images) are served from Cloudflare R2 via signed URLs.

### VM Sizing (Serving)

| Config | RAM | Antfly + Embeddings | Notes |
|--------|-----|---------------------|-------|
| e2-small (2GB) | Too small | N/A | Pebble OOMs on large datasets |
| **e2-standard-2 (8GB)** | **Works** | **~2-3s search** | Good for <500k records |
| e2-standard-4 (16GB) | Comfortable | ~2-3s search | Needed if also running VLM inference |

For serving only (no VLM inference), **e2-standard-2 (8GB) is sufficient**. The bge-small-en-v1.5 embedding model is tiny (~128MB) and runs fine on CPU.

### Step 1: Provision the VM

```bash
# <!-- CUSTOMIZE: VM name, zone, machine type -->
gcloud compute instances create my-vm-name \
  --zone=us-west1-c \
  --machine-type=e2-standard-2 \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB
```

Note the ephemeral IP from the output. For production, consider a static IP:

```bash
# <!-- CUSTOMIZE: address name, region, zone, VM name -->
gcloud compute addresses create my-static-ip --region=us-west1
gcloud compute instances delete-access-config my-vm-name --zone=us-west1-c --access-config-name="External NAT"
gcloud compute instances add-access-config my-vm-name --zone=us-west1-c --address=<STATIC_IP>
```

### Step 2: Install system dependencies

```bash
gcloud compute ssh my-vm-name  # <!-- CUSTOMIZE: VM name -->

# Update packages
sudo apt update && sudo apt upgrade -y

# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# Install Node.js + pnpm (for building frontend)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm
```

### Step 3: Install antfly-omni

You need the **omni** build (includes ONNX Runtime + XLA backends for termite embeddings). The plain `antfly` binary doesn't include ML inference support.

```bash
# <!-- CUSTOMIZE: version number -->
AF_VERSION=0.0.14

# Download antfly-omni release
curl -fsSL "https://releases.antfly.io/antfly/v${AF_VERSION}/antfly-omni_${AF_VERSION}_Linux_x86_64.tar.gz" \
  -o /tmp/antfly-omni.tar.gz

# Extract and install
mkdir -p ~/.local/bin
tar -xzf /tmp/antfly-omni.tar.gz -C /tmp
cp /tmp/antfly ~/.local/bin/antfly
chmod +x ~/.local/bin/antfly

# Install ONNX Runtime shared libraries (bundled in the omni tarball)
sudo mkdir -p /usr/local/lib/antfly
sudo cp /tmp/lib/*.so* /usr/local/lib/antfly/
sudo ldconfig /usr/local/lib/antfly

# Verify
~/.local/bin/antfly version
# Should show: antfly-omni v0.0.14 (or your version)
```

**Important**: The ONNX Runtime libraries (`libonnxruntime.so`, `libonnxruntime-genai.so`, and the PJRT plugin) must be in `LD_LIBRARY_PATH` at runtime. The systemd service file handles this.

### Step 4: Pull the embedding model

Antfly's embedded termite needs an embedding model for semantic search. This is separate from any generative models you might use for inference pipelines.

```bash
export LD_LIBRARY_PATH=/usr/local/lib/antfly:$LD_LIBRARY_PATH
~/.local/bin/antfly termite pull hf:BAAI/bge-small-en-v1.5 --type embedder

# Model lands in ~/.termite/models/embedders/BAAI/bge-small-en-v1.5/
# Size: ~128MB
```

**Gotcha**: The model name in `config.yaml` preload list must match the directory name without the `BAAI/` prefix — use `bge-small-en-v1.5`, not `BAAI/bge-small-en-v1.5`.

### Step 5: Transfer the database

Package your local antfly data directory and upload it:

```bash
# From local machine — package the database
# <!-- CUSTOMIZE: path to your local antfly data directory -->
tar -czf /tmp/antflydb.tar.gz -C ~/.antfly .

# Upload to VM (this can be large — ~1-2GB for 100k records)
# <!-- CUSTOMIZE: VM name, zone -->
gcloud compute scp /tmp/antflydb.tar.gz my-vm-name:~ --zone=us-west1-c

# On VM — extract to the data directory
mkdir -p ~/.antfly
cd ~/.antfly && tar -xzf ~/antflydb.tar.gz && rm ~/antflydb.tar.gz
```

**Critical**: The data directory must contain `metadata/`, `store/`, and numbered raft group dirs (e.g., `1/`) at its root level. If your local data lives in `~/.antfly/antflydb/`, you need the *contents* of that directory, not the directory itself. Getting this wrong causes antfly to re-initialize empty shards, silently overwriting your data.

### Step 6: Configure antfly

Create `config.yaml`:

```yaml
# <!-- CUSTOMIZE: all paths -->
storage:
  local:
    base_dir: /home/youruser/.antfly  # Where pebble stores data

max_shards_per_table: 4
default_shards_per_table: 2

termite:
  api_url: http://localhost:11433
  models_dir: /home/youruser/.termite/models  # <!-- CUSTOMIZE -->
  preload:
    - bge-small-en-v1.5

# Only needed if serving media from R2
remote_content:
  s3:
    r2:
      endpoint: ${R2_ENDPOINT_URL}
      access_key_id: ${R2_ACCESS_KEY_ID}
      secret_access_key: ${R2_SECRET_ACCESS_KEY}
```

Create `.env` for secrets:

```bash
# <!-- CUSTOMIZE: your R2 credentials (or remove if not using R2) -->
cat > ~/.env << 'EOF'
R2_ENDPOINT_URL=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your_key_id
R2_SECRET_ACCESS_KEY=your_secret_key
EOF
chmod 600 ~/.env
```

### Step 7: Set up systemd service

```bash
sudo tee /etc/systemd/system/antfly.service << 'EOF'
[Unit]
Description=Antfly vector database
After=network.target

[Service]
Type=simple
User=youruser                             # <!-- CUSTOMIZE -->
WorkingDirectory=/home/youruser           # <!-- CUSTOMIZE -->
ExecStart=/home/youruser/.local/bin/antfly swarm --data-dir /home/youruser/.antfly --config /home/youruser/config.yaml  # <!-- CUSTOMIZE: all paths -->
Restart=on-failure
RestartSec=5

Environment=HOME=/home/youruser           # <!-- CUSTOMIZE -->
Environment=LD_LIBRARY_PATH=/usr/local/lib/antfly
EnvironmentFile=/home/youruser/.env        # <!-- CUSTOMIZE -->

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable antfly
sudo systemctl start antfly

# Check it started
sudo journalctl -u antfly -f
# Look for: "swarm node ready" and "preloaded embedder model"
```

**Key flags**:
- `--data-dir` defaults to `"antflydb"` (relative to CWD), not `~/.antfly`. Always set it explicitly.
- `--termite` defaults to `true` — embedded termite starts automatically.

### Step 8: Build and deploy the frontend

```bash
# <!-- CUSTOMIZE: repo URL -->
git clone <your-repo-url> ~/gif-picker
cd ~/gif-picker/web
pnpm install && pnpm build

sudo mkdir -p /var/www/honeycomb
sudo cp -r dist/* /var/www/honeycomb/
```

Or build locally and SCP the dist:

```bash
# Local machine
# <!-- CUSTOMIZE: local project path, VM name, zone -->
cd /path/to/gif-picker && make web-build
gcloud compute scp --recurse web/dist my-vm-name:~/honeycomb-dist --zone=us-west1-c

# On VM
sudo mkdir -p /var/www/honeycomb
sudo cp -r ~/honeycomb-dist/* /var/www/honeycomb/
```

### Step 9: Configure Caddy

```bash
sudo tee /etc/caddy/Caddyfile << 'CADDYEOF'
# HTTP-only block for testing before DNS is ready
:80 {
    handle /api/* {
        reverse_proxy localhost:8080
    }

    handle {
        root * /var/www/honeycomb
        try_files {path} /index.html
        file_server
    }

    encode gzip
}

# <!-- CUSTOMIZE: your domain -->
your-app.example.com {
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

# Optional: admin panel on a subdomain
# <!-- CUSTOMIZE: domain, username, password hash -->
admin.your-app.example.com {
    # Exempt ACME challenges from auth — otherwise Let's Encrypt can't validate
    @notAcme not path /.well-known/acme-challenge/*
    basic_auth @notAcme {
        # Generate hash: caddy hash-password --plaintext <password>
        yourusername $2a$14$YOUR_BCRYPT_HASH
    }

    reverse_proxy localhost:8080

    encode gzip

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
CADDYEOF

sudo systemctl reload caddy
```

**Gotcha — bcrypt hashes and shell escaping**: Bcrypt hashes contain `$` characters that get expanded by bash. If you're writing the Caddyfile via a script or heredoc, use `'EOF'` (single-quoted) to prevent expansion, or write the file via Python/a programming language. We burned significant time debugging this.

**Gotcha — ACME and basic_auth**: If you put `basic_auth` on a domain block without exempting `/.well-known/acme-challenge/*`, Let's Encrypt's HTTP-01 validation will get a 401 and TLS certificate issuance will fail silently. Use the `@notAcme` matcher pattern shown above.

### Step 10: DNS and verification

Point your domain's A record to the VM's IP address.

```bash
# Test before DNS propagates (via IP)
curl http://<VM_IP>/api/v1/tables

# Test after DNS propagates
curl https://your-app.example.com/api/v1/tables

# Check antfly logs
sudo journalctl -u antfly --since "5 min ago"
```

DNS propagation can take up to an hour depending on your TTL. While waiting, you can test via the `:80` block using the VM's IP directly.

### Deployment gotchas summary

| Issue | Symptom | Fix |
|-------|---------|-----|
| Wrong antfly build | "No embedder models directory configured" | Use `antfly-omni`, not plain `antfly` |
| Data dir structure wrong | Shards re-initialize empty (data loss!) | Ensure `metadata/`, `store/`, `1/` are at data-dir root |
| `--data-dir` not set | Antfly creates `./antflydb/` in CWD | Always pass `--data-dir` explicitly |
| Model name mismatch | "model not found" at search time | Use `bge-small-en-v1.5` not `BAAI/bge-small-en-v1.5` in preload |
| Missing LD_LIBRARY_PATH | antfly starts but termite inference fails | Set in systemd Environment |
| bcrypt `$` in Caddyfile | Broken password hash, 403 on all requests | Write Caddyfile via code, not shell heredoc |
| ACME blocked by basic_auth | TLS cert never issues, ERR_SSL errors | Exempt `/.well-known/acme-challenge/*` from auth |

---

## Part 2: Running Termite Standalone for VLM Inference

This section covers running Termite standalone with generative models (e.g., Gemma 3 VLM) for batch tasks like generating image descriptions. This requires more resources than serving.

### VM Sizing (VLM Inference)

| Config | RAM | Vision Inference | Notes |
|--------|-----|-----------------|-------|
| e2-medium (4GB) | Too small | N/A | OOM even loading model |
| e2-standard-2 (8GB) | Barely fits | OOM on vision requests | Model uses ~7.6GB |
| **e2-standard-4 (16GB)** | **Works** | **~3 min/frame** | Minimum for Gemma 3 4B |
| **g2-standard-4 + L4 GPU** | **16GB + 24GB VRAM** | **~3-5 sec/frame** | **Best option for batch work** |

**Rule of thumb**: Gemma 3 4B ONNX INT4 needs ~8GB RAM. Vision inference needs additional headroom. **16GB minimum.**

### Quick Reference

```bash
# Build termite-omni with ONNX support (on your local machine)
# <!-- CUSTOMIZE: path to antfly repo -->
cd ~/Documents/antfly/antfly-repo/termite
./scripts/download-onnxruntime.sh
ONNXRUNTIME_ROOT=$(pwd)/onnxruntime \
CGO_ENABLED=1 \
LIBRARY_PATH=$(pwd)/onnxruntime/linux-amd64/lib \
go build -tags="onnx,ORT" -o /tmp/termite-omni ./cmd/termite

# Copy to VM
# <!-- CUSTOMIZE: VM name, zone -->
gcloud compute scp /tmp/termite-omni my-vm-name:~/termite-omni --zone=us-west1-c

# Pull model on VM
./termite-omni pull hf:onnxruntime/Gemma-3-ONNX

# Run
export LD_LIBRARY_PATH=$HOME/.local/onnxruntime/lib:$LD_LIBRARY_PATH
export ORT_DYLIB_PATH=$HOME/.local/onnxruntime/lib/libonnxruntime.so
./termite-omni run
```

### Required Libraries

Termite needs two ONNX Runtime libraries for generative models:

1. **libonnxruntime.so** - Core ONNX Runtime
2. **libonnxruntime-genai.so** - GenAI extension (for text generation)

The `download-onnxruntime.sh` script in the termite repo fetches both. If setting up manually:

```bash
# ONNX Runtime (v1.24.1)
curl -fsSL "https://github.com/microsoft/onnxruntime/releases/download/v1.24.1/onnxruntime-linux-x64-1.24.1.tgz" | tar xz
cp onnxruntime-linux-x64-1.24.1/lib/* ~/.local/onnxruntime/lib/

# ONNX Runtime GenAI (v0.12.0)
curl -fsSL "https://github.com/microsoft/onnxruntime-genai/releases/download/v0.12.0/onnxruntime-genai-0.12.0-linux-x64.tar.gz" | tar xz
cp onnxruntime-genai-0.12.0-linux-x64/lib/*.so* ~/.local/onnxruntime/lib/
```

### Model Setup

```bash
# Pull from HuggingFace (note the hf: prefix!)
./termite-omni pull hf:onnxruntime/Gemma-3-ONNX

# Model lands in:
# ~/.termite/models/generators/onnxruntime/Gemma-3-ONNX/
# Size: ~5.6GB (INT4 quantized)
```

The `hf:` prefix is required for HuggingFace models. Without it, Termite looks in its own registry.

### Start Script

Save as `~/start_termite.sh`:

```bash
#!/bin/bash
export LD_LIBRARY_PATH=$HOME/.local/onnxruntime/lib:$LD_LIBRARY_PATH
export ORT_DYLIB_PATH=$HOME/.local/onnxruntime/lib/libonnxruntime.so
nohup ./termite-omni run > termite_omni.log 2>&1 &
echo "Termite started (PID: $!)"
```

### API Usage

Termite exposes an OpenAI-compatible API on port 11433:

```bash
# Text generation
curl -s http://localhost:11433/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"onnxruntime/Gemma-3-ONNX",
       "messages":[{"role":"user","content":"Hello"}],
       "max_tokens":256}'

# Vision (multimodal)
curl -s http://localhost:11433/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"onnxruntime/Gemma-3-ONNX",
       "messages":[{"role":"user","content":[
         {"type":"text","text":"Describe this image"},
         {"type":"image_url","image_url":{"url":"data:image/png;base64,<BASE64>"}}
       ]}],
       "max_tokens":512}'
```

### Port Conflict with antfly

If the VM runs `antfly swarm` with embedded termite, port 11433 is already in use. Stop antfly first, or configure termite to use a different port:

```bash
sudo systemctl stop antfly
# Then start standalone termite
```

---

## Performance Benchmarks

### CPU (e2-standard-4, 16GB RAM)

| Test | Time | Notes |
|------|------|-------|
| Text generation (cold) | ~53s | Includes model loading (~1 min) |
| Text generation (warm) | ~10s | Model already in memory |
| Vision, 1 frame (70KB PNG) | ~3 min | Consistent across tests |
| Vision, 5 frames | ~10 min | Not 5x slower — frames processed together |

### GPU (g2-standard-4 + L4, CUDA INT4 variant)

| Test | Time | Notes |
|------|------|-------|
| Text generation (cold) | **~6s** | Includes model loading to VRAM (~8GB) |
| Text generation (warm) | **~0.4s** | 28x faster than CPU |
| Vision, 1 frame | **~3s** (cold), **~0.6s** (warm) | 60x faster than CPU cold |
| Vision, 5 frames | **~4.7s/GIF** (pipeline avg) | CPU failed! GPU handles it easily |
| Pipeline: 25 GIFs x 1 frame | **84s total** (~3.4s/GIF) | CPU: ~75 min (54x faster) |
| Pipeline: 25 GIFs x 5 frames | **118s total** (~4.7s/GIF) | CPU: timeout/fail |
| VRAM usage | 9-15 GB of 23 GB | Headroom available |
| Concurrency (2-3 workers) | No throughput gain | GPU serializes requests internally |

Keep-alive timeout is 5 minutes. After that, model is evicted and next request has cold start.

---

## GPU Setup (Tested & Working)

### What Termite supports

Termite auto-detects CUDA via `nvidia-smi` or `libcudart.so`. No special build flags needed beyond the standard `onnx,ORT` — GPU vs CPU is a **runtime** decision. The same binary works for both.

### CUDA variant setup

`termite pull` only downloads CPU INT4 files. For GPU, manually download and overwrite:

```bash
# 1. Provision VM (Ubuntu 24.04 DLVM — has CUDA 12.8 pre-installed)
# <!-- CUSTOMIZE: VM name, zone -->
gcloud compute instances create my-gpu-vm \
  --zone=us-central1-a \
  --machine-type=g2-standard-4 \
  --accelerator=type=nvidia-l4,count=1 \
  --image-family=common-cu128-ubuntu-2404-nvidia-570 \
  --image-project=deeplearning-platform-release \
  --boot-disk-size=50GB \
  --maintenance-policy=TERMINATE

# 2. Install ONNX Runtime GPU libraries
mkdir -p ~/.local/onnxruntime-gpu/lib
cd /tmp
curl -fsSL "https://github.com/microsoft/onnxruntime/releases/download/v1.24.1/onnxruntime-linux-x64-gpu-1.24.1.tgz" | tar xz
cp onnxruntime-linux-x64-gpu-1.24.1/lib/*.so* ~/.local/onnxruntime-gpu/lib/
curl -fsSL "https://github.com/microsoft/onnxruntime-genai/releases/download/v0.12.0/onnxruntime-genai-0.12.0-linux-x64-cuda.tar.gz" | tar xz
cp onnxruntime-genai-0.12.0-linux-x64-cuda/lib/*.so* ~/.local/onnxruntime-gpu/lib/

# 3. Pull base model (gets CPU variant)
export LD_LIBRARY_PATH=$HOME/.local/onnxruntime-gpu/lib:$LD_LIBRARY_PATH
export ORT_DYLIB_PATH=$HOME/.local/onnxruntime-gpu/lib/libonnxruntime.so
./termite-omni pull hf:onnxruntime/Gemma-3-ONNX

# 4. Download CUDA variant and overwrite CPU files
python3 -m venv ~/hfvenv && ~/hfvenv/bin/pip install huggingface-hub
~/hfvenv/bin/python -c "
from huggingface_hub import snapshot_download
snapshot_download('onnxruntime/Gemma-3-ONNX',
    allow_patterns=['gemma-3-4b-it/gpu/cuda-bf16-io-int4-rtn-block-32/*'],
    local_dir='/tmp/gemma-cuda')
"
MODEL_DIR=~/.termite/models/generators/onnxruntime/Gemma-3-ONNX
cp /tmp/gemma-cuda/gemma-3-4b-it/gpu/cuda-bf16-io-int4-rtn-block-32/*.onnx $MODEL_DIR/
cp /tmp/gemma-cuda/gemma-3-4b-it/gpu/cuda-bf16-io-int4-rtn-block-32/*.onnx.data $MODEL_DIR/
cp /tmp/gemma-cuda/gemma-3-4b-it/gpu/cuda-bf16-io-int4-rtn-block-32/genai_config.json $MODEL_DIR/
rm -rf /tmp/gemma-cuda ~/.cache/huggingface

# 5. Start Termite — should log "ONNX Runtime (CUDA)" and "NVIDIA L4"
./termite-omni run
```

### Key learnings

- **Image family**: Must use `common-cu128-ubuntu-2404-nvidia-570` (not debian-12, which has glibc 2.35 — too old for termite binary)
- **HuggingFace path**: CUDA variant is at `gemma-3-4b-it/gpu/cuda-bf16-io-int4-rtn-block-32/` (not `gpu/...`)
- **No version conflicts**: ONNX Runtime GPU 1.24.1 + GenAI CUDA 0.12.0 work together with CUDA 12.8
- **Concurrency**: GPU serializes inference requests internally — `--workers 1` is optimal
- **VRAM**: Model uses 8-15 GB of 23 GB available on L4

---

## Available Backends

Termite supports multiple inference backends:

| Backend | Build Tags | GPU Support | Best For |
|---------|-----------|-------------|----------|
| **ONNX Runtime** | `onnx,ORT` | CUDA (runtime) | Production, fast inference |
| **XLA/PJRT** | `xla,XLA` | CUDA, TPU | TPU workloads |
| **CoreML** | `coreml` | Apple Neural Engine | macOS/Apple Silicon |
| **Go (fallback)** | (none) | CPU only | Development, no deps |

For GPU on GCE, ONNX Runtime with CUDA is the simplest path.

## Batching Architecture

Termite uses two distinct code paths in `backend_ortgenai.go`:

1. **Text-only**: `session.Generate()` — eligible for continuous batching via new ortgenai Engine API ([knights-analytics/ortgenai#8](https://github.com/knights-analytics/ortgenai/pull/8))
2. **Multimodal/VLM**: `session.GenerateWithImages()` — uses separate image loading + `<start_of_image>` token injection. **Not supported by the Engine API.**

Both paths are hardcoded to `BatchSize: 1`. The Engine API (continuous batching) only helps text-only workloads. For VLM, there is no batching path — each request processes one sequence at a time regardless of concurrency.

---

## Known Issues & Workarounds

### 1. SSH Dies Under CPU Load

Heavy inference (100% CPU) makes the VM unresponsive to SSH. This is a real operational issue.

**Workarounds:**
- Always run inference via `nohup` scripts, not interactive SSH
- Use `gcloud compute instances reset` to recover
- Check results after inference completes, don't try to monitor in real time
- Consider `nice -n 19` to leave some CPU for sshd (untested)

### 2. Gemma JSON Output Quirks

Gemma 3 4B has formatting quirks when asked for JSON:

- Outputs unicode `▁` (U+2581) before JSON keys
- Wraps in markdown code fences (`` ```json ... ``` ``)
- Sometimes outputs 6 backticks instead of 3 at the end

The `clean_json_response()` function in describe.py handles all of these. Key cleanup:

```python
text = text.replace("\u2581", "")  # Remove unicode spacing
# Strip code fences
# Find outermost {} and truncate trailing garbage
```

### 3. Disk Space

Budget ~20GB free for VLM inference:
- Generative model: 5.6GB
- ONNX Runtime libs: ~500MB
- HuggingFace cache during download: ~5.7GB (can clean after)

For antfly serving only, budget ~5GB plus your database size.

```bash
# Clean HF cache after model is pulled
rm -rf ~/.cache/huggingface
```

### 4. Model Keep-Alive Timeout

Termite evicts models after 5 minutes of inactivity. If your pipeline has gaps between requests, you'll hit cold starts (~1 min model reload). This is logged as:

```
msg="Evicting generator model from cache" reason="expired (keep-alive timeout)"
```

### 5. antfly install script may 404

The `releases.antfly.io` install script sometimes fails to resolve the correct download URL. If you get 404/400 errors, download the tarball directly:

```bash
# Direct download URL pattern:
# https://releases.antfly.io/antfly/v{VERSION}/antfly-omni_{VERSION}_Linux_x86_64.tar.gz
```

---

## GPU Profiling (bench.py)

The benchmark harness supports a `--profile` flag that captures GPU utilization time series alongside request boundary events:

```bash
uv run bench.py \
  --endpoint http://localhost:11433/openai/v1 \
  --model onnxruntime/Gemma-3-ONNX \
  --workload vlm-5frame --concurrency 1 --requests 20 \
  --label termite-profile --profile
```

Outputs two additional files per run:
- `.gpu.csv` — GPU util %, memory controller util %, VRAM MB, power W at 0.5s intervals
- `.events.jsonl` — `request_start`/`first_token`/`request_end` with elapsed timestamps

### Profiling Results (L4 GPU, 20 VLM requests x 5 frames, c=1)

| Metric | Value |
|--------|-------|
| Throughput | 23.8 tok/s |
| p50 latency | 1,421 ms |
| p50 TTFT | 144 ms |
| Peak VRAM | 8,026 MB / 23,034 MB (35%) |
| Avg GPU util (during inference) | ~95% |
| Avg GPU util (including warmup) | 46.2% |

Key insight: per-request, the GPU is well-utilized at 95-96%. The serialization bottleneck matters at higher concurrency — requests queue rather than batch.

---

## Cost

| VM Type | $/hour | Use Case |
|---------|--------|----------|
| e2-standard-2 | ~$0.07 | Antfly serving only (no VLM) |
| e2-standard-4 | ~$0.17 | CPU VLM inference (slow) |
| g2-standard-4 + L4 | ~$0.70 | GPU VLM inference (fast) |
| e2-medium | ~$0.03 | Idle / between jobs |

For batch VLM work, resize up before the job and back down after:

```bash
# <!-- CUSTOMIZE: VM name, zone -->
gcloud compute instances stop my-vm-name --zone=us-west1-c
gcloud compute instances set-machine-type my-vm-name --zone=us-west1-c --machine-type=e2-standard-4
gcloud compute instances start my-vm-name --zone=us-west1-c

# ... run your batch job ...

# Resize back down
gcloud compute instances stop my-vm-name --zone=us-west1-c
gcloud compute instances set-machine-type my-vm-name --zone=us-west1-c --machine-type=e2-medium
gcloud compute instances start my-vm-name --zone=us-west1-c
```

---

## File Layout Reference

After a full deployment, the VM filesystem looks like:

```
~/.local/bin/antfly              # antfly-omni binary
~/.antfly/                       # antfly data directory
  ├── metadata/                  #   cluster metadata (pebble)
  ├── store/                     #   data store metadata
  └── 1/                         #   raft group (contains shard pebble DBs)
~/.termite/models/
  └── embedders/BAAI/bge-small-en-v1.5/   # embedding model (for antfly)
  └── generators/onnxruntime/Gemma-3-ONNX/ # VLM model (for batch inference)
~/.env                           # R2 credentials (chmod 600)
~/gif-picker/                    # app repo
  ├── config.yaml
  └── deploy/
/var/www/honeycomb/              # frontend static files
/usr/local/lib/antfly/           # ONNX Runtime shared libraries
/etc/systemd/system/antfly.service
/etc/caddy/Caddyfile
```
