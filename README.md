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

For an authenticated endpoint, set `ANTFLY_AUTHORIZATION` to the complete upstream
Authorization header in a separate, secured ingestion environment. Use a
write-capable ingestion credential, never the public backend's read credential.
CR/LF is rejected and the credential is not printed. `--url` / `ANTFLY_URL` and
`--table` / `INGEST_TABLE` retain their existing behavior.

### 5. Search

Use Node 24 and pnpm 10.11.0. Start the application backend and Vite in separate
terminals (with Antfly running locally):

```bash
make web-install
make server   # terminal 1: application API on localhost:8090
make web      # terminal 2: Vite proxies /api to the application
```

For an existing production build, `make serve` serves both UI and API. Build it
first with `make web-build`. `make web-remote` retains the remote application
proxy option. `make test` runs frontend/server tests and backend typechecking.

See [runtime and deployment documentation](deploy/README.md) for all environment
variables, public API limits, container packaging and manual VM prerequisites.
The browser no longer talks directly to Antfly. Public visitors need no login;
upstream credentials and content policy belong to the server. These repository
changes do not deploy the application, change the live Caddy configuration, or
modify Colony or the database.

## Setup

```
cp .env.example .env   # add R2 credentials
make setup              # install Playwright for scrapers
```

Requires:
- Antfly running (`antfly swarm`)
- API keys in `~/.tokens/` (gemini_api_key, openrouter_api_key)
- R2 credentials in `.env`
- Node 24 and pnpm 10.11.0 for the application (no runtime npm dependencies)

## Config

Model pricing for cost tracking: `ingest/image-to-text/models.yaml`
