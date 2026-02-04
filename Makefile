# GIF Picker Makefile
#
# Prerequisites:
#   - Antfly running: antfly swarm
#   - CLIP model: antflycli termite pull openai/clip-vit-base-patch32

# Path to TGIF dataset TSV file
TGIF_TSV ?= $(HOME)/Documents/antfly/datasets/TGIF-Release/data/tgif-v1.0.tsv

# Antfly API URL
ANTFLY_URL ?= http://localhost:8080/api/v1

# Ingest settings
INGEST_BATCH_SIZE ?= 50
INGEST_TABLE ?= tgif_gifs

.PHONY: help ingest ingest-small ingest-text-only ingest-text-only-small ingest-clip-fixed ingest-clip-fixed-small termite-fixed standalone web web-install web-build test lint clean

help:
	@echo "GIF Picker - Available targets:"
	@echo ""
	@echo "  ingest              - Ingest full TGIF dataset (~100k GIFs) via antfly's termite"
	@echo "  ingest-small        - Ingest small test batch (100 GIFs) via antfly's termite"
	@echo ""
	@echo "  --- Text-Only Pipeline (descriptions via antfly's built-in termite) ---"
	@echo "  ingest-text-only       - Ingest full descriptions dataset via antfly's termite"
	@echo "  ingest-text-only-small - Ingest 100 descriptions via antfly's termite"
	@echo ""
	@echo "  --- Fixed CLIP Pipeline (uses termite-clip-fix binary) ---"
	@echo "  termite-fixed       - Start the fixed termite binary on port 11434"
	@echo "  ingest-clip-fixed   - Ingest full TGIF dataset with fixed CLIP embeddings"
	@echo "  ingest-clip-fixed-small - Ingest 100 GIFs with fixed CLIP embeddings"
	@echo ""
	@echo "  standalone          - Standalone CLIP test (bypasses Antfly, uses Termite directly)"
	@echo "  web                 - Start the web development server"
	@echo "  web-install         - Install web dependencies"
	@echo "  web-build           - Build web app for production"
	@echo "  test                - Run web tests"
	@echo "  lint                - Run linter"
	@echo "  clean               - Remove build artifacts"
	@echo ""
	@echo "Configuration (via environment variables):"
	@echo "  TGIF_TSV      - Path to tgif-v1.0.tsv (default: ~/datasets/TGIF-Release/data/tgif-v1.0.tsv)"
	@echo "  ANTFLY_URL    - Antfly API URL (default: http://localhost:8080/api/v1)"
	@echo ""
	@echo "Prerequisites for fixed CLIP pipeline:"
	@echo "  1. Start fixed termite:  make termite-fixed (in separate terminal)"
	@echo "  2. Start Antfly:         antfly swarm"
	@echo "  3. Run ingest:           make ingest-clip-fixed-small"

# Full dataset ingestion
ingest:
	@if [ ! -f "$(TGIF_TSV)" ]; then \
		echo "Error: TGIF dataset not found at $(TGIF_TSV)"; \
		echo "Set TGIF_TSV environment variable to the correct path"; \
		exit 1; \
	fi
	cd ingest && go run main.go \
		-tsv "$(TGIF_TSV)" \
		-url "$(ANTFLY_URL)" \
		-table "$(INGEST_TABLE)" \
		-batch $(INGEST_BATCH_SIZE)

# Small test batch (100 GIFs)
ingest-small:
	@if [ ! -f "$(TGIF_TSV)" ]; then \
		echo "Error: TGIF dataset not found at $(TGIF_TSV)"; \
		echo "Set TGIF_TSV environment variable to the correct path"; \
		exit 1; \
	fi
	cd ingest && go run main.go \
		-tsv "$(TGIF_TSV)" \
		-url "$(ANTFLY_URL)" \
		-table "$(INGEST_TABLE)" \
		-batch $(INGEST_BATCH_SIZE) \
		-limit 100

# --- Text-Only Pipeline (uses antfly's built-in termite for embeddings) ---
DESCRIPTIONS_JSONL ?= gif_descriptions.jsonl
INGEST_TEXT_TABLE ?= tgif_gifs_text

# Full descriptions dataset
ingest-text-only:
	@if [ ! -f "$(DESCRIPTIONS_JSONL)" ]; then \
		echo "Error: Descriptions file not found at $(DESCRIPTIONS_JSONL)"; \
		echo "Run describe_gifs.py first, or set DESCRIPTIONS_JSONL"; \
		exit 1; \
	fi
	cd ingest && go run ingest_text.go \
		-url "$(ANTFLY_URL)" \
		-jsonl "../$(DESCRIPTIONS_JSONL)" \
		-table "$(INGEST_TEXT_TABLE)" \
		-batch $(INGEST_BATCH_SIZE)

# Small test batch (100 descriptions)
ingest-text-only-small:
	@if [ ! -f "$(DESCRIPTIONS_JSONL)" ]; then \
		echo "Error: Descriptions file not found at $(DESCRIPTIONS_JSONL)"; \
		echo "Run describe_gifs.py first, or set DESCRIPTIONS_JSONL"; \
		exit 1; \
	fi
	cd ingest && go run ingest_text.go \
		-url "$(ANTFLY_URL)" \
		-jsonl "../$(DESCRIPTIONS_JSONL)" \
		-table "$(INGEST_TEXT_TABLE)" \
		-batch $(INGEST_BATCH_SIZE) \
		-limit 100

# --- Fixed CLIP Pipeline ---
# ONNX Runtime library path (adjust if your antfly-repo is elsewhere)
ONNX_LIB_PATH ?= $(HOME)/Documents/antfly/antfly-repo/termite/onnxruntime/linux-amd64-gpu/lib

# Start the fixed termite binary (run in separate terminal)
termite-fixed:
	@echo "Starting fixed termite on port 11434..."
	@echo "Using ONNX libs from: $(ONNX_LIB_PATH)"
	@echo "Press Ctrl+C to stop"
	LD_LIBRARY_PATH=$(ONNX_LIB_PATH):$$LD_LIBRARY_PATH ./termite-clip-fix run --config termite-fixed.yaml

# Full dataset with fixed CLIP
ingest-clip-fixed:
	@if [ ! -f "$(TGIF_TSV)" ]; then \
		echo "Error: TGIF dataset not found at $(TGIF_TSV)"; \
		echo "Set TGIF_TSV environment variable to the correct path"; \
		exit 1; \
	fi
	cd ingest && go run ingest_clip_fixed.go \
		-tsv "$(TGIF_TSV)" \
		-url "$(ANTFLY_URL)" \
		-batch $(INGEST_BATCH_SIZE)

# Small test batch with fixed CLIP (100 GIFs)
ingest-clip-fixed-small:
	@if [ ! -f "$(TGIF_TSV)" ]; then \
		echo "Error: TGIF dataset not found at $(TGIF_TSV)"; \
		echo "Set TGIF_TSV environment variable to the correct path"; \
		exit 1; \
	fi
	cd ingest && go run ingest_clip_fixed.go \
		-tsv "$(TGIF_TSV)" \
		-url "$(ANTFLY_URL)" \
		-batch $(INGEST_BATCH_SIZE) \
		-limit 100

# Standalone CLIP test (bypasses Antfly, uses Termite directly)
standalone:
	@if [ ! -f "$(TGIF_TSV)" ]; then \
		echo "Error: TGIF dataset not found at $(TGIF_TSV)"; \
		echo "Set TGIF_TSV environment variable to the correct path"; \
		exit 1; \
	fi
	cd standalone && go run main.go \
		-tsv "$(TGIF_TSV)" \
		-limit 20

# Web development server
web: web-install
	cd web && pnpm dev

# Install web dependencies
web-install:
	cd web && pnpm install

# Build web app for production
web-build: web-install
	cd web && pnpm build

# Run tests
test:
	cd web && pnpm test:run

# Run linter
lint:
	cd web && pnpm lint

# Clean build artifacts
clean:
	rm -rf web/dist
