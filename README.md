# Honeycomb GIF Picker

GIF search engine powered by Antfly vector database and Gemini descriptions.

## Pipeline

### 1. Scrape & Upload

Discover GIFs from a source and upload media to R2:

```
make scrape SRC=gifgif
make upload SRC=gifgif
```

### 2. Compare models (small sample)

Run several vision models on a small sample to evaluate quality before committing to a full run.
Each model calls the API independently; results are written to separate JSONL files in `ingest/image-to-text/output/`.

```
make compare N=20 MODELS="gemini-3.1-flash-lite-preview,gemini-2.5-flash-lite,openrouter:google/gemma-3-4b-it"
```

This auto-generates `review.md` with GIFs and descriptions inline for side-by-side evaluation.

### 3. Describe (full run)

Once you've picked a model, generate descriptions for the whole dataset:

```
make describe N=100
make describe N=100 MODEL=gemini-2.5-flash-lite
make describe N=100 SRC=gifgif          # filter to one source
```

### 4. Ingest

Load descriptions into Antfly for vector search.
Always reads from `descriptions-latest.jsonl`, which is symlinked by `make describe` to the most recent model's output:

```
make ingest
```

### 5. Search

Start the web UI:

```
make web
```

## Setup

```
cp .env.example .env   # add R2 credentials
make setup              # install Playwright for scrapers
```

Requires:
- Antfly running (`antfly swarm`)
- API keys in `~/.tokens/` (gemini_api_key, openrouter_api_key)
- R2 credentials in `.env`

## Config

Model pricing for cost tracking: `ingest/image-to-text/models.yaml`

## Antfly Cloud lift-and-shift migration

Use `scripts/migrate_to_antfly_cloud.py` to move this table to Antfly Cloud without re-running GIF description or embedding jobs. The script copies stored documents plus `_embeddings` through public Antfly APIs and creates the destination vector index as `external: true`.

Recommended rehearsal:

```bash
# 1. Log in and choose a Cloud instance with the customer-facing CLI.
antfly-cloud login
antfly-cloud antfly env <instance>   # export the destination URL/token it prints

# 2. Export/analyze locally only.
uv run scripts/migrate_to_antfly_cloud.py \
  --source-url http://localhost:8080/api/v1 \
  --table honeycomb \
  --export-path .migration/honeycomb.ndjson \
  --dry-run

# 3. Import into a scratch Cloud table.
uv run scripts/migrate_to_antfly_cloud.py \
  --source-url http://localhost:8080/api/v1 \
  --dest-url "$ANTFLY_URL" \
  --dest-bearer-token "$ANTFLY_TOKEN" \
  --table honeycomb \
  --dest-table honeycomb_migration_test \
  --export-path .migration/honeycomb.ndjson \
  --skip-export \
  --yes
```

Notes:

- This is a customer-grade path: no local data directory copying and no Antfly-internal Cloud admin hooks.
- If the source API cannot project `_embeddings`, stop and add/fix a public export endpoint; do not fall back to re-embedding.
- The migrated table preserves document vectors. Text semantic queries against an external index must supply query vectors through the `embeddings` query field or use a small query-embedding adapter.

