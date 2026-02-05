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

.PHONY: help describe describe-small filter-descriptions ingest ingest-small ingest-text-only ingest-text-only-small ingest-clip-fixed ingest-clip-fixed-small termite-fixed standalone web web-remote web-install web-build test lint clean scrape-one describe-sources describe-source ingest-sources ingest-source pipeline-one status

help:
	@echo "GIF Picker - Available targets:"
	@echo ""
	@echo "  ingest              - Ingest full TGIF dataset (~100k GIFs) via antfly's termite"
	@echo "  ingest-small        - Ingest small test batch (100 GIFs) via antfly's termite"
	@echo ""
	@echo "  --- Text-Only Pipeline (descriptions via antfly's built-in termite) ---"
	@echo "  describe               - Generate descriptions for all GIFs via Gemini (resumable)"
	@echo "  describe-small         - Generate descriptions for 1000 GIFs (N=1000 by default)"
	@echo "  filter-descriptions    - Remove Tumblr-removed GIFs from descriptions JSONL"
	@echo "  ingest-text-only       - Ingest full descriptions dataset via antfly's termite"
	@echo "  ingest-text-only-small - Ingest 100 descriptions via antfly's termite"
	@echo ""
	@echo "  --- Fixed CLIP Pipeline (uses termite-clip-fix binary) ---"
	@echo "  termite-fixed       - Start the fixed termite binary on port 11434"
	@echo "  ingest-clip-fixed   - Ingest full TGIF dataset with fixed CLIP embeddings"
	@echo "  ingest-clip-fixed-small - Ingest 100 GIFs with fixed CLIP embeddings"
	@echo ""
	@echo "  standalone          - Standalone CLIP test (bypasses Antfly, uses Termite directly)"
	@echo ""
	@echo "  --- Source-Agnostic Pipeline (sources/*) ---"
	@echo "  scrape-one SRC=X       - Run scraper for source X"
	@echo "  describe-sources       - Describe all undescribed items across all sources"
	@echo "  describe-source SRC=X  - Describe undescribed items for source X"
	@echo "  ingest-sources         - Ingest all sources into Antfly"
	@echo "  ingest-source SRC=X    - Ingest source X into Antfly"
	@echo "  pipeline-one SRC=X     - Full pipeline (scrape+describe+ingest) for source X"
	@echo "  status                 - Show download/describe status for all sources"
	@echo ""
	@echo "  web                 - Start the web development server (local Antfly)"
	@echo "  web-remote          - Start the web dev server (remote: honeycomb.rowan.earth)"
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

# --- Text-Only Pipeline ---
DESCRIPTIONS_JSONL ?= gif_descriptions.jsonl
INGEST_TEXT_TABLE ?= tgif_gifs_text
TGIF_ATTRIBUTION ?= TGIF dataset

# Generate descriptions via Gemini (resumable)
#   make describe              - all GIFs
#   make describe-small        - 1000 GIFs (default)
#   make describe-small N=500  - custom count
DESCRIBE_WORKERS ?= 20

describe:
	@if [ ! -f "$(TGIF_TSV)" ]; then \
		echo "Error: TGIF dataset not found at $(TGIF_TSV)"; \
		echo "Set TGIF_TSV environment variable to the correct path"; \
		exit 1; \
	fi
	uv run describe_gifs.py \
		--tsv "$(TGIF_TSV)" \
		--output "$(DESCRIPTIONS_JSONL)" \
		--workers $(DESCRIBE_WORKERS) \
		--limit 0 \
		--resume

N ?= 1000
describe-small:
	@if [ ! -f "$(TGIF_TSV)" ]; then \
		echo "Error: TGIF dataset not found at $(TGIF_TSV)"; \
		echo "Set TGIF_TSV environment variable to the correct path"; \
		exit 1; \
	fi
	uv run describe_gifs.py \
		--tsv "$(TGIF_TSV)" \
		--output "$(DESCRIPTIONS_JSONL)" \
		--workers $(DESCRIBE_WORKERS) \
		--limit $(N) \
		--resume

# Filter out GIFs removed by Tumblr (copyright/guideline violations) from descriptions
filter-descriptions:
	@if [ ! -f "$(DESCRIPTIONS_JSONL)" ]; then \
		echo "Error: Descriptions file not found at $(DESCRIPTIONS_JSONL)"; \
		exit 1; \
	fi
	@python3 -c "\
	import json; \
	lines = open('$(DESCRIPTIONS_JSONL)').readlines(); \
	kept = [l for l in lines if 'content has been removed' not in json.loads(l).get('literal','').lower()]; \
	open('$(DESCRIPTIONS_JSONL)','w').writelines(kept); \
	print(f'Filtered: {len(lines)-len(kept)} removed, {len(kept)} kept')"

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
		-batch $(INGEST_BATCH_SIZE) \
		-attribution "$(TGIF_ATTRIBUTION)"

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
		-attribution "$(TGIF_ATTRIBUTION)" \
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

# ============================================================
# Source-Agnostic Pipeline (sources/*)
# ============================================================

SOURCES_DIR := sources

# Scrape a single source: make scrape-one SRC=kidmograph
scrape-one:
	@test -n "$(SRC)" || (echo "Usage: make scrape-one SRC=<source_name>" && exit 1)
	@test -f "$(SOURCES_DIR)/$(SRC)/scrape.py" || (echo "Error: $(SOURCES_DIR)/$(SRC)/scrape.py not found" && exit 1)
	uv run $(SOURCES_DIR)/$(SRC)/scrape.py

# Describe all sources
describe-sources:
	uv run describe_sources.py --workers $(DESCRIBE_WORKERS)

# Describe a single source
describe-source:
	@test -n "$(SRC)" || (echo "Usage: make describe-source SRC=<source_name>" && exit 1)
	uv run describe_sources.py --source $(SRC) --workers $(DESCRIBE_WORKERS)

# Ingest all sources that have descriptions
ingest-sources:
	@for jsonl in $(SOURCES_DIR)/*/descriptions.jsonl; do \
		if [ -f "$$jsonl" ]; then \
			src=$$(basename $$(dirname "$$jsonl")); \
			echo "=== Ingesting $$src ==="; \
			cd ingest && go run ingest_text.go \
				-url "$(ANTFLY_URL)" \
				-jsonl "../$$jsonl" \
				-table "$(INGEST_TEXT_TABLE)" \
				-batch $(INGEST_BATCH_SIZE) \
				-skip-create; \
			cd ..; \
		fi \
	done

# Ingest a single source
ingest-source:
	@test -n "$(SRC)" || (echo "Usage: make ingest-source SRC=<source_name>" && exit 1)
	@test -f "$(SOURCES_DIR)/$(SRC)/descriptions.jsonl" || (echo "Error: $(SOURCES_DIR)/$(SRC)/descriptions.jsonl not found. Run describe-source first." && exit 1)
	cd ingest && go run ingest_text.go \
		-url "$(ANTFLY_URL)" \
		-jsonl "../$(SOURCES_DIR)/$(SRC)/descriptions.jsonl" \
		-table "$(INGEST_TEXT_TABLE)" \
		-batch $(INGEST_BATCH_SIZE) \
		-skip-create

# Full pipeline for a single source
pipeline-one:
	@test -n "$(SRC)" || (echo "Usage: make pipeline-one SRC=<source_name>" && exit 1)
	$(MAKE) scrape-one SRC=$(SRC)
	$(MAKE) describe-source SRC=$(SRC)
	$(MAKE) ingest-source SRC=$(SRC)

# Show status of all sources
status:
	@echo "Source pipeline status:"
	@echo ""
	@for manifest in $(SOURCES_DIR)/*/manifest.json; do \
		if [ -f "$$manifest" ]; then \
			src=$$(basename $$(dirname "$$manifest")); \
			total=$$(python3 -c "import json; m=json.load(open('$$manifest')); print(len(m['items']))"); \
			downloaded=$$(python3 -c "import json; m=json.load(open('$$manifest')); print(sum(1 for i in m['items'] if i.get('downloaded')))"); \
			described=$$(python3 -c "import json; m=json.load(open('$$manifest')); print(sum(1 for i in m['items'] if i.get('described')))"); \
			echo "  $$src: $$total items, $$downloaded downloaded, $$described described"; \
		fi \
	done
	@if [ ! -d "$(SOURCES_DIR)" ] || [ -z "$$(ls $(SOURCES_DIR)/*/manifest.json 2>/dev/null)" ]; then \
		echo "  (no sources scraped yet)"; \
	fi

# Web development server
web: web-install
	cd web && pnpm dev

# Web dev server using remote API (honeycomb.rowan.earth)
web-remote: web-install
	cd web && REMOTE=1 pnpm dev

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
