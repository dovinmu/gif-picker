# Honeycomb GIF Picker

GIF search engine powered by Antfly vector database and Gemini descriptions.

## Pipeline

### 1. Scrape & Upload

Discover GIFs from a source and upload media to R2:

```
make scrape SRC=gifgif
make upload SRC=gifgif
```

### 2. Describe

Generate rich text descriptions of each GIF using a vision model.

**From R2 bucket (recommended):**
```
make describe-r2 N=100
make describe-r2 N=100 MODEL=gemini-2.5-flash-lite
```

**Compare models side-by-side:**
```
make compare-models N=20 MODELS="gemini-3.1-flash-lite-preview,gemini-2.5-flash-lite,openrouter:google/gemma-3-4b-it"
```

This generates `review.md` with GIFs and descriptions inline for evaluation.

### 3. Ingest

Load descriptions into Antfly for vector search:

```
make ingest-r2
make ingest-r2 MODEL=gemini-2.5-flash-lite
```

### 4. Search

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
