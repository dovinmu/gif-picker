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
