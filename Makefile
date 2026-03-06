# GIF Picker Makefile
#
# Prerequisites:
#   - Antfly running: antfly swarm
#   - Text embedding model: antflycli termite pull BAAI/bge-small-en-v1.5 --type embedder

# Load .env file if it exists
-include .env
export

# Antfly API URL
ANTFLY_URL ?= http://localhost:8080/api/v1

# Ingest settings
INGEST_BATCH_SIZE ?= 50
INGEST_TABLE ?= tgif_gifs_text

# Describe settings
DESCRIBE_WORKERS ?= 20
MODEL ?= gemini-3.1-flash-lite-preview
DESCRIBE_OUTPUT_DIR := ingest/image-to-text/output

# Sources
SOURCES_DIR := sources

.PHONY: help setup scrape upload describe describe-source ingest ingest-source ingest-r2 pipeline status web web-remote web-install web-build test lint clean test-prompt describe-r2 compare-models review

help:
	@echo "GIF Picker - Available targets:"
	@echo ""
	@echo "  --- Source Pipeline ---"
	@echo "  scrape SRC=X           - Discover items for source X (build manifest)"
	@echo "  upload SRC=X           - Upload source X media to R2"
	@echo "  upload-all             - Upload all sources to R2"
	@echo "  describe SRC=X         - Generate Gemini descriptions for source X"
	@echo "  describe-all           - Generate descriptions for all sources"
	@echo "  ingest SRC=X           - Ingest source X into Antfly"
	@echo "  ingest-all             - Ingest all sources into Antfly"
	@echo "  pipeline SRC=X         - Scrape + upload only"
	@echo "  pipeline SRC=X DESCRIBE=1 - Full pipeline (scrape+upload+describe+ingest)"
	@echo "  status                 - Show pipeline status for all sources"
	@echo ""
	@echo ""
	@echo "  --- Image-to-Text Pipeline (Gemini descriptions) ---"
	@echo "  test-prompt N=10       - Quick prompt iteration test (N GIFs from local TGIF)"
	@echo "  describe-r2 N=100      - Generate descriptions from R2 bucket"
	@echo "  describe-r2 MODEL=X    - Use a specific model"
	@echo "  compare-models N=20 MODELS=\"model1,model2\" - Compare models side-by-side"
	@echo "  ingest-r2              - Ingest describe-r2 output into Antfly"
	@echo "  review                 - Regenerate review.md from description files"
	@echo ""
	@echo "  --- Setup ---"
	@echo "  setup                  - Install all pipeline dependencies (Playwright, etc.)"
	@echo ""
	@echo "  --- Web ---"
	@echo "  web                    - Start the web development server (local Antfly)"
	@echo "  web-remote             - Start the web dev server (remote: honeycomb.rowan.earth)"
	@echo "  web-install            - Install web dependencies"
	@echo "  web-build              - Build web app for production"
	@echo "  test                   - Run web tests"
	@echo "  lint                   - Run linter"
	@echo "  clean                  - Remove build artifacts"

# ============================================================
# Source Pipeline
# ============================================================

setup:
	uv run --with playwright python -m playwright install chromium

scrape:
	@test -n "$(SRC)" || (echo "Usage: make scrape SRC=<source_name>" && exit 1)
	@test -f "$(SOURCES_DIR)/$(SRC)/scrape.py" || (echo "Error: $(SOURCES_DIR)/$(SRC)/scrape.py not found" && exit 1)
	uv run $(SOURCES_DIR)/$(SRC)/scrape.py

upload:
	@test -n "$(SRC)" || (echo "Usage: make upload SRC=<source_name>" && exit 1)
	uv run ingest/save-to-r2/upload_r2.py --source $(SRC)

upload-all:
	uv run ingest/save-to-r2/upload_r2.py --all-sources

describe:
	@test -n "$(SRC)" || (echo "Usage: make describe SRC=<source_name>" && exit 1)
	uv run describe_sources.py --source $(SRC) --workers $(DESCRIBE_WORKERS)

describe-all:
	uv run describe_sources.py --workers $(DESCRIBE_WORKERS)

ingest:
	@test -n "$(SRC)" || (echo "Usage: make ingest SRC=<source_name>" && exit 1)
	uv run ingest/embed-text-descriptions/embed.py \
		--source $(SRC) \
		--url "$(ANTFLY_URL)" \
		--table "$(INGEST_TABLE)" \
		--batch-size $(INGEST_BATCH_SIZE)

ingest-all:
	uv run ingest/embed-text-descriptions/embed.py \
		--all-sources \
		--url "$(ANTFLY_URL)" \
		--table "$(INGEST_TABLE)" \
		--batch-size $(INGEST_BATCH_SIZE)

# Ingest descriptions from describe-r2 output into Antfly
MEDIA_BASE_URL ?= https://media.honeycomb.antfly.io
ingest-r2:
	@test -f "$(DESCRIBE_OUTPUT_DIR)/descriptions-$(MODEL).jsonl" || \
		(echo "Error: $(DESCRIBE_OUTPUT_DIR)/descriptions-$(MODEL).jsonl not found. Run make describe-r2 first." && exit 1)
	uv run ingest/embed-text-descriptions/embed.py \
		--jsonl "$(DESCRIBE_OUTPUT_DIR)/descriptions-$(MODEL).jsonl" \
		--url "$(ANTFLY_URL)" \
		--table "$(INGEST_TABLE)" \
		--batch-size $(INGEST_BATCH_SIZE) \
		--media-base-url "$(MEDIA_BASE_URL)"

pipeline:
	@test -n "$(SRC)" || (echo "Usage: make pipeline SRC=<source_name> [DESCRIBE=1]" && exit 1)
	$(MAKE) scrape SRC=$(SRC)
	$(MAKE) upload SRC=$(SRC)
ifdef DESCRIBE
	$(MAKE) describe SRC=$(SRC)
	$(MAKE) ingest SRC=$(SRC)
else
	@echo ""
	@echo "NOTE: Skipped describe+ingest. To generate descriptions and ingest, run:"
	@echo "  make pipeline SRC=$(SRC) DESCRIBE=1"
	@echo "  (or separately: make describe SRC=$(SRC) && make ingest SRC=$(SRC))"
endif

status:
	@echo "Source pipeline status:"
	@echo ""
	@for manifest in $(SOURCES_DIR)/*/manifest.json; do \
		if [ -f "$$manifest" ]; then \
			src=$$(basename $$(dirname "$$manifest")); \
			total=$$(python3 -c "import json; m=json.load(open('$$manifest')); print(len(m['items']))"); \
			uploaded=$$(python3 -c "import json; m=json.load(open('$$manifest')); print(sum(1 for i in m['items'] if i.get('r2_url')))"); \
			described=$$(python3 -c "import json; m=json.load(open('$$manifest')); print(sum(1 for i in m['items'] if i.get('described')))"); \
			echo "  $$src: $$total items, $$uploaded on R2, $$described described"; \
		fi \
	done
	@if [ ! -d "$(SOURCES_DIR)" ] || [ -z "$$(ls $(SOURCES_DIR)/*/manifest.json 2>/dev/null)" ]; then \
		echo "  (no sources scraped yet)"; \
	fi

# ============================================================
# Web
# ============================================================

web: web-install
	cd web && pnpm dev

web-remote: web-install
	cd web && REMOTE=1 pnpm dev

web-install:
	cd web && pnpm install

web-build: web-install
	cd web && pnpm build

test:
	cd web && pnpm test:run

lint:
	cd web && pnpm lint

clean:
	rm -rf web/dist

# ============================================================
# Image-to-Text Pipeline (direct R2 access)
# ============================================================

# Path to TGIF dataset TSV file (for local testing)
TGIF_TSV ?= $(HOME)/Documents/antfly/datasets/TGIF-Release/data/tgif-v1.0.tsv
N ?= 100

# Quick prompt iteration test (processes N GIFs from local TGIF)
test-prompt:
	@if [ ! -f "$(TGIF_TSV)" ]; then \
		echo "Error: TGIF dataset not found at $(TGIF_TSV)"; \
		exit 1; \
	fi
	@mkdir -p ingest/image-to-text/output
	uv run ingest/image-to-text/describe.py \
		--source tgif \
		--tsv "$(TGIF_TSV)" \
		--output "ingest/image-to-text/output/test_descriptions.jsonl" \
		--prompt "ingest/image-to-text/prompt.txt" \
		--workers 5 \
		--limit $(N)
	@echo ""
	@echo "=== Sample output (first item) ==="
	@head -1 ingest/image-to-text/output/test_descriptions.jsonl | python3 -m json.tool

# Generate descriptions from R2 bucket (single model)
describe-r2:
	@test -n "$(R2_BUCKET)" || (echo "Error: R2_BUCKET not set" && exit 1)
	@mkdir -p $(DESCRIBE_OUTPUT_DIR)
	uv run ingest/image-to-text/describe.py \
		--source r2 \
		--r2-bucket "$(R2_BUCKET)" \
		--backend genai \
		--model $(MODEL) \
		--output "$(DESCRIBE_OUTPUT_DIR)/descriptions-$(MODEL).jsonl" \
		--prompt "ingest/image-to-text/prompt.txt" \
		--workers $(DESCRIBE_WORKERS) \
		--limit $(N) \
		--resume
	$(MAKE) review

# Generate descriptions with multiple models for comparison
# Usage: make compare-models N=20 MODELS="gemini-3.1-flash-lite-preview,gemini-2.5-flash"
# Models prefixed with "openrouter:" use the OpenRouter backend (e.g. openrouter:google/gemma-3-4b-it)
compare-models:
	@test -n "$(R2_BUCKET)" || (echo "Error: R2_BUCKET not set" && exit 1)
	@test -n "$(MODELS)" || (echo "Usage: make compare-models N=20 MODELS=\"model1,model2\"" && exit 1)
	@mkdir -p $(DESCRIBE_OUTPUT_DIR)
	@for spec in $$(echo "$(MODELS)" | tr ',' ' '); do \
		echo ""; \
		case "$$spec" in \
			openrouter:*) \
				model=$${spec#openrouter:}; \
				backend=openrouter; \
				;; \
			*) \
				model=$$spec; \
				backend=genai; \
				;; \
		esac; \
		safe_name=$$(echo "$$model" | tr '/' '-'); \
		echo "=== Running model: $$model ($$backend) ==="; \
		uv run ingest/image-to-text/describe.py \
			--source r2 \
			--r2-bucket "$(R2_BUCKET)" \
			--backend "$$backend" \
			--model "$$model" \
			--output "$(DESCRIBE_OUTPUT_DIR)/descriptions-$$safe_name.jsonl" \
			--prompt "ingest/image-to-text/prompt.txt" \
			--workers $(DESCRIBE_WORKERS) \
			--limit $(N); \
	done
	$(MAKE) review

# Generate review markdown from all description files
review:
	uv run ingest/image-to-text/review.py \
		--input $(DESCRIBE_OUTPUT_DIR)/descriptions-*.jsonl \
		--output "$(DESCRIBE_OUTPUT_DIR)/review.md"
