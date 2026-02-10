# GIF Picker Makefile
#
# Prerequisites:
#   - Antfly running: antfly swarm
#   - Text embedding model: antflycli termite pull BAAI/bge-small-en-v1.5 --type embedder

# Path to TGIF dataset TSV file
TGIF_TSV ?= $(HOME)/Documents/antfly/datasets/TGIF-Release/data/tgif-v1.0.tsv

# Antfly API URL
ANTFLY_URL ?= http://localhost:8080/api/v1

# Ingest settings
INGEST_BATCH_SIZE ?= 50
INGEST_TABLE ?= tgif_gifs_text
TGIF_ATTRIBUTION ?= TGIF dataset
DESCRIPTIONS_JSONL ?= gif_descriptions.jsonl

# Describe settings
DESCRIBE_WORKERS ?= 20
N ?= 1000

# Sources
SOURCES_DIR := sources

.PHONY: help describe describe-small filter-descriptions ingest ingest-small ingest-sources ingest-source upload-r2 upload-r2-source upload-r2-tgif pipeline scrape-one describe-sources describe-source status web web-remote web-install web-build test lint clean

help:
	@echo "GIF Picker - Available targets:"
	@echo ""
	@echo "  --- Description Pipeline ---"
	@echo "  describe               - Generate descriptions for all GIFs via Gemini (resumable)"
	@echo "  describe-small         - Generate descriptions for 1000 GIFs (N=1000 by default)"
	@echo "  filter-descriptions    - Remove Tumblr-removed GIFs from descriptions JSONL"
	@echo ""
	@echo "  --- R2 Upload ---"
	@echo "  upload-r2              - Upload all source media to R2"
	@echo "  upload-r2-source SRC=X - Upload one source to R2"
	@echo "  upload-r2-tgif         - Upload TGIF GIFs to R2"
	@echo ""
	@echo "  --- Ingestion ---"
	@echo "  ingest                 - Ingest full descriptions dataset into Antfly"
	@echo "  ingest-small           - Ingest 100 descriptions (test batch)"
	@echo "  ingest-sources         - Ingest all sources into Antfly"
	@echo "  ingest-source SRC=X    - Ingest source X into Antfly"
	@echo ""
	@echo "  --- Source Pipeline ---"
	@echo "  scrape-one SRC=X       - Run scraper for source X"
	@echo "  describe-sources       - Describe all undescribed items across all sources"
	@echo "  describe-source SRC=X  - Describe undescribed items for source X"
	@echo "  pipeline SRC=X         - Full pipeline (scrape+describe+upload-r2+ingest) for source X"
	@echo "  status                 - Show pipeline status for all sources"
	@echo ""
	@echo "  --- Web ---"
	@echo "  web                 - Start the web development server (local Antfly)"
	@echo "  web-remote          - Start the web dev server (remote: honeycomb.rowan.earth)"
	@echo "  web-install         - Install web dependencies"
	@echo "  web-build           - Build web app for production"
	@echo "  test                - Run web tests"
	@echo "  lint                - Run linter"
	@echo "  clean               - Remove build artifacts"

# ============================================================
# Description Pipeline
# ============================================================

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

# ============================================================
# R2 Upload
# ============================================================

upload-r2:
	uv run pipeline/upload_r2.py --all-sources

upload-r2-source:
	@test -n "$(SRC)" || (echo "Usage: make upload-r2-source SRC=<source_name>" && exit 1)
	uv run pipeline/upload_r2.py --source $(SRC)

upload-r2-tgif:
	uv run pipeline/upload_r2.py --tgif --jsonl "$(DESCRIPTIONS_JSONL)"

# ============================================================
# Ingestion
# ============================================================

ingest:
	@if [ ! -f "$(DESCRIPTIONS_JSONL)" ]; then \
		echo "Error: Descriptions file not found at $(DESCRIPTIONS_JSONL)"; \
		echo "Run describe_gifs.py first, or set DESCRIPTIONS_JSONL"; \
		exit 1; \
	fi
	uv run pipeline/ingest.py \
		--jsonl "$(DESCRIPTIONS_JSONL)" \
		--url "$(ANTFLY_URL)" \
		--table "$(INGEST_TABLE)" \
		--batch-size $(INGEST_BATCH_SIZE) \
		--attribution "$(TGIF_ATTRIBUTION)"

ingest-small:
	@if [ ! -f "$(DESCRIPTIONS_JSONL)" ]; then \
		echo "Error: Descriptions file not found at $(DESCRIPTIONS_JSONL)"; \
		echo "Run describe_gifs.py first, or set DESCRIPTIONS_JSONL"; \
		exit 1; \
	fi
	uv run pipeline/ingest.py \
		--jsonl "$(DESCRIPTIONS_JSONL)" \
		--url "$(ANTFLY_URL)" \
		--table "$(INGEST_TABLE)" \
		--batch-size $(INGEST_BATCH_SIZE) \
		--attribution "$(TGIF_ATTRIBUTION)" \
		--limit 100

ingest-sources:
	uv run pipeline/ingest.py \
		--all-sources \
		--url "$(ANTFLY_URL)" \
		--table "$(INGEST_TABLE)" \
		--batch-size $(INGEST_BATCH_SIZE) \
		--skip-create

ingest-source:
	@test -n "$(SRC)" || (echo "Usage: make ingest-source SRC=<source_name>" && exit 1)
	uv run pipeline/ingest.py \
		--source $(SRC) \
		--url "$(ANTFLY_URL)" \
		--table "$(INGEST_TABLE)" \
		--batch-size $(INGEST_BATCH_SIZE) \
		--skip-create

# ============================================================
# Source Pipeline
# ============================================================

scrape-one:
	@test -n "$(SRC)" || (echo "Usage: make scrape-one SRC=<source_name>" && exit 1)
	@test -f "$(SOURCES_DIR)/$(SRC)/scrape.py" || (echo "Error: $(SOURCES_DIR)/$(SRC)/scrape.py not found" && exit 1)
	uv run $(SOURCES_DIR)/$(SRC)/scrape.py

describe-sources:
	uv run describe_sources.py --workers $(DESCRIBE_WORKERS)

describe-source:
	@test -n "$(SRC)" || (echo "Usage: make describe-source SRC=<source_name>" && exit 1)
	uv run describe_sources.py --source $(SRC) --workers $(DESCRIBE_WORKERS)

pipeline:
	@test -n "$(SRC)" || (echo "Usage: make pipeline SRC=<source_name>" && exit 1)
	$(MAKE) scrape-one SRC=$(SRC)
	$(MAKE) describe-source SRC=$(SRC)
	$(MAKE) upload-r2-source SRC=$(SRC)
	$(MAKE) ingest-source SRC=$(SRC)

status:
	@echo "Source pipeline status:"
	@echo ""
	@for manifest in $(SOURCES_DIR)/*/manifest.json; do \
		if [ -f "$$manifest" ]; then \
			src=$$(basename $$(dirname "$$manifest")); \
			total=$$(python3 -c "import json; m=json.load(open('$$manifest')); print(len(m['items']))"); \
			downloaded=$$(python3 -c "import json; m=json.load(open('$$manifest')); print(sum(1 for i in m['items'] if i.get('downloaded')))"); \
			described=$$(python3 -c "import json; m=json.load(open('$$manifest')); print(sum(1 for i in m['items'] if i.get('described')))"); \
			uploaded=$$(python3 -c "import json; m=json.load(open('$$manifest')); print(sum(1 for i in m['items'] if i.get('r2_url')))"); \
			echo "  $$src: $$total items, $$downloaded downloaded, $$described described, $$uploaded on R2"; \
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
