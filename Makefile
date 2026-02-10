# GIF Picker Makefile
#
# Prerequisites:
#   - Antfly running: antfly swarm
#   - Text embedding model: antflycli termite pull BAAI/bge-small-en-v1.5 --type embedder

# Antfly API URL
ANTFLY_URL ?= http://localhost:8080/api/v1

# Ingest settings
INGEST_BATCH_SIZE ?= 50
INGEST_TABLE ?= tgif_gifs_text

# Describe settings
DESCRIBE_WORKERS ?= 20

# Sources
SOURCES_DIR := sources

.PHONY: help setup scrape upload describe describe-source ingest ingest-source pipeline status web web-remote web-install web-build test lint clean

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
	@echo "  pipeline SRC=X         - Full pipeline (scrape+upload+describe+ingest)"
	@echo "  status                 - Show pipeline status for all sources"
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
	uv run pipeline/upload_r2.py --source $(SRC)

upload-all:
	uv run pipeline/upload_r2.py --all-sources

describe:
	@test -n "$(SRC)" || (echo "Usage: make describe SRC=<source_name>" && exit 1)
	uv run describe_sources.py --source $(SRC) --workers $(DESCRIBE_WORKERS)

describe-all:
	uv run describe_sources.py --workers $(DESCRIBE_WORKERS)

ingest:
	@test -n "$(SRC)" || (echo "Usage: make ingest SRC=<source_name>" && exit 1)
	uv run pipeline/ingest.py \
		--source $(SRC) \
		--url "$(ANTFLY_URL)" \
		--table "$(INGEST_TABLE)" \
		--batch-size $(INGEST_BATCH_SIZE)

ingest-all:
	uv run pipeline/ingest.py \
		--all-sources \
		--url "$(ANTFLY_URL)" \
		--table "$(INGEST_TABLE)" \
		--batch-size $(INGEST_BATCH_SIZE)

pipeline:
	@test -n "$(SRC)" || (echo "Usage: make pipeline SRC=<source_name>" && exit 1)
	$(MAKE) scrape SRC=$(SRC)
	$(MAKE) upload SRC=$(SRC)
	$(MAKE) describe SRC=$(SRC)
	$(MAKE) ingest SRC=$(SRC)

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
