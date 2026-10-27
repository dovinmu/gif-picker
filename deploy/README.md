# Honeycomb application runtime and deployment

This repository prepares Honeycomb to run as one Node 24 service: the backend
serves the built UI and a constrained public API. It does not apply a live
configuration, deploy Honeycomb, change DNS/firewalls, provision Cloud resources,
modify Colony, or migrate the database. The checked-in Caddy template no longer
publishes a general Antfly proxy; that does not establish what a running VM
currently exposes. Applying it requires a separately authorized deployment.

## Local development and production build

Use Node 24 and pnpm 10.11.0 (the version pinned in `web/package.json`). Start
Antfly locally with the existing `config.yaml` and BGE-small embedding model; the
application does not install models, change indexes, or fetch GIF media itself.

```bash
# Terminal 1: backend, defaults to the local Antfly API
make server

# Terminal 2: Vite, proxies /api to localhost:8090
make web
```

Run `make web-install` first if dependencies are not installed. `make web-remote`
keeps the existing development option of proxying application `/api` calls to
`https://honeycomb.rowan.earth`; it does not proxy arbitrary database operations.
There is no development `/termite` proxy. For a production build locally:

```bash
make web-build
make serve
# http://localhost:8090
```

`make serve` serves the existing `web/dist` plus the API; it does not rebuild it.
Static paths are resolved relative to the server source, not the current working
directory. Missing dist leaves liveness/API usable and returns 503 for frontend
requests. SPA fallback is only for extensionless non-API GET/HEAD paths; missing
assets are 404 and HEAD never sends a body.

`make test` runs frontend tests, Node server tests and server typechecking.

## Startup configuration

Environment is read once at startup; restart the process to apply changes.
Invalid values fail startup with a field-specific error, without secret values.

| Variable | Default | Contract |
| --- | --- | --- |
| `PORT` | `8090` | Integer 1–65535; listens on `0.0.0.0`. |
| `ANTFLY_URL` | `http://localhost:8080/api/v1` | Complete API base, preserving `/api/v1` or `/db/v1`; trailing slash is trimmed. HTTP(S) only, no credentials/query/fragment. Plain HTTP is allowed only for loopback hosts; remote endpoints require HTTPS. |
| `ANTFLY_TABLE` | `honeycomb` | Nonempty; encoded as one path segment, never selectable by callers. |
| `ANTFLY_AUTHORIZATION` | omitted | Optional complete Authorization header; empty omits it, CR/LF is rejected. Required for non-loopback endpoints. Never logged or supplied by visitors. |
| `NSFW` | unset (SFW) | Only `1` disables tag/rating restrictions. Removed-content filtering remains active. This is an operator setting, not a browser build flag or request option. |
| `MAX_CONCURRENT_QUERIES` | `16` | Positive integer; per-process in-flight limit, not a global rate limit. |

Authorization uses the upstream's complete header convention, for example
`ApiKey <base64(keyId:keySecret)>` or `Bearer <token>`. A bare API key is **not**
a Bearer token. Supply the backend a table-scoped, read/query-capable credential
through the runtime's secret mechanism, not the image, source tree, browser,
command logs or public Caddy configuration. Caller cookies and Authorization
headers are never forwarded upstream. Local unauthenticated swarms remain usable.

## Public HTTP contract

Visitors do not need credentials. The only query operations are:

| Method and path | Input | Output |
| --- | --- | --- |
| `POST /api/search` | JSON `{ "query": "cat", "limit": 20, "mood": "happy" }` | `{ "results": [...], "total": number }` |
| `POST /api/random` | JSON `{ "limit": 30, "mood": "happy" }` | Same result shape. |
| `GET /api/gifs/:id` | URL-encoded record ID | Existing GIF record shape, or 404 if missing/filtered. |
| `GET /healthz` | None | 200 `{ "ok": true }`; process liveness only, no upstream request or index-readiness guarantee. |

Search requires a string query of at most 2048 UTF-16 code units. Limit is an
integer 1–50, default 50 for search and 30 for random. Mood is optional; when
present it must be nonempty and at most 64 code units. Decoded IDs must be
nonempty and at most 512 code units. POST bodies must be JSON, at most 16 KiB;
unknown fields (including table/index/offset/query-body/NSFW overrides) are 400.
Search preserves quoted phrases, semantic text, `tag:`, `-tag:`, `rating:` and
mood controls, including combined phrase/semantic RRF retrieval. Positive and
negative tags are exact, case-insensitive postfilters; quoted/backslash tag
values are literal, not raw query-language input. `total` is the upstream
candidate count, not an exact postfilter count. GIF metadata and `?gif=` deep
links are retained. Random browse caches totals per server instance, caps its
offset at 2000, shuffles records, and retries an empty nonzero-offset page once
at zero within the same deadline and concurrency slot.

SFW blocks tags `porn`, `sexual`, `nsfw`, `adult-content` and rating `x`.
Removed-content descriptions are excluded in both modes. Policy applies to
search, random browse and direct ID lookup; a blocked ID returns 404.

The backend sends only POST table-query requests to its configured Antfly base.
There is no generic `/api` passthrough, `/termite` endpoint, or public database
admin hostname. Unknown API paths return JSON 404, and known operations with a
wrong method return 405. Other error responses are `{ "error": string }`:

- 400: invalid JSON, values or unknown fields; 413: body too large;
  415: unsupported content type.
- 429 with `Retry-After: 1`: all query slots occupied; requests are not queued.
- 504: the single 10-second upstream deadline expires (including body reading).
- 502: upstream HTTP/query/schema failure, invalid JSON, or response over 4 MiB.

Upstream redirects are not followed. Disconnecting callers abort upstream work,
and slots are released on every exit path. Errors never return raw upstream
bodies, credentials or stack traces, and upstream failures are not represented
as successful empty searches or missing records.

## Container

```bash
docker build -t honeycomb .
# Example: a trusted remote HTTPS API with a runtime-only environment file
docker run --rm -p 8090:8090 --env-file /secure/path/honeycomb.env honeycomb
```

The multi-stage image builds and typechecks with Node 24 and pinned pnpm using
the frozen lockfile. Runtime is `node:24-bookworm-slim`, user `node`, with only
server TypeScript, shared DTO types, the ES-module package boundary and `dist`.
It needs no `node_modules`, database binary, inference service or ingestion data.
The context allowlist excludes repository history, environment/credential files,
media, ingestion outputs and local database state. Never bake secrets into an
image. Cloud Run can provide its own `PORT` and runtime secret configuration;
this change does not create or deploy a Cloud Run service.

Container loopback refers to the container itself. For isolated smoke testing,
run a fake upstream in the same network namespace or use a trusted HTTPS
fixture. Plain HTTP `host.docker.internal` is intentionally not allowed as a
remote endpoint. Fixture smoke does not qualify real model inference or GIF
playback; those require the intended Antfly/model/media environment.

## Existing VM: manual prerequisites and installation

These are **separately authorized operator steps**, not actions performed during
PR preparation. Preserve the existing Antfly service, `config.yaml` and database.
Do not expose Antfly administration through the public application; use trusted
SSH/local access or the managed control plane. This template does not change
firewall rules: review the deployed network policy separately.

Prerequisites:

- Existing Ubuntu/Debian VM, `rowan` user with sudo, repository at
  `/home/rowan/gif-picker`, and working Antfly/model configuration.
- Node **24** installed at **`/usr/bin/node`**, and pnpm **10.11.0** on PATH.
  Install these manually; `deploy.sh` does not install system packages.
- Caddy installed and public hostnames/DNS already configured as appropriate.
- `honeycomb.service` manually installed **and enabled** before `deploy.sh`.
- Optional runtime environment at `/home/rowan/.config/honeycomb.env`, protected
  with mode 0600. Keep `PORT=8090` to match this VM's Caddy and deployment probes.
  This file uses systemd EnvironmentFile syntax; shell `export` is not needed.

After reviewing paths, domains and runtime configuration, operators can install:

```bash
cd /home/rowan/gif-picker
pnpm --dir web install --frozen-lockfile
pnpm --dir web server:typecheck
pnpm --dir web build
sudo cp deploy/honeycomb.service /etc/systemd/system/honeycomb.service
sudo systemctl daemon-reload
sudo systemctl enable --now honeycomb.service
curl --fail http://localhost:8090/healthz
curl --fail -H 'Content-Type: application/json' \
  --data '{"query":"cat","limit":1}' http://localhost:8090/api/search

# Separately authorize this public routing change before applying it.
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The entire site, including `:80`, forwards to `localhost:8090`; the backend
serves frontend and API together. Nothing is copied to `/var/www/honeycomb`.
The checked-in public template removes the separate
`admin.honeycomb.rowan.earth` Antfly proxy. Do not copy the legacy local
`Caddyfile.dev` as a substitute for the reviewed template.

For subsequent authorized releases, run `./deploy/deploy.sh dev` (VM
`honeycomb-dev`) or `./deploy/deploy.sh prod` (VM `honeycomb`), in `us-west1-c`.
It checks Node 24, pinned pnpm and the installed/enabled unit **before changing
anything**, then pulls fast-forward-only, installs with the frozen lockfile,
typechecks/builds, restarts the application and fails on liveness/search errors.
It does not install units, alter Caddy, enumerate tables or restart Antfly.
Inspect `journalctl -u honeycomb -f`, `systemctl status honeycomb`, and Caddy logs
when investigating an authorized deployment.

## Authenticated primary ingestion

`ingest/embed-text-descriptions/embed.py` retains `--url` / `ANTFLY_URL`,
`--table` / `INGEST_TABLE`, BGE-small (384 dimensions), schema and media URLs.
It optionally reads `ANTFLY_AUTHORIZATION` as the same **complete** header and
rejects CR/LF without printing the value. Empty/unset leaves local access
unauthenticated. Configure a separate write-capable ingestion environment;
**never reuse that credential for the public application's read-only service**.

```bash
# In a separately secured ingestion shell, load the write-capable credential
# from your secret manager into ANTFLY_AUTHORIZATION; do not print it.
uv run ingest/embed-text-descriptions/embed.py \
  --jsonl /path/to/descriptions.jsonl \
  --url https://trusted-antfly.example/api/v1 --table honeycomb --limit 1
```

Ingestion writes directly to the trusted upstream, not through Honeycomb's public
API. Other administrative scripts remain trusted local tools; this is not a
Cloud data migration. Verify authenticated ingestion only against an isolated
fixture before separately authorizing any live database writes.

## PR preparation verification

Verified locally with Node 24.22.1 and pnpm 10.11.0:

- Frozen dependency installation, backend typecheck, 38 existing UI tests,
  six HTTP integration tests, and the production frontend build.
- Isolated upstream fixtures: SFW/NSFW publication policy, exact tags/ratings,
  negative tags, fallback metadata, random-page recovery, forbidden database
  routes, input limits, concurrent-query rejection, disconnect cancellation,
  the real ten-second deadline, bounded upstream failures and redirects.
- Actual application processes against both `/api/v1` and `/db/v1` fixtures:
  liveness, search, browse, filtered detail, built assets, HEAD and SPA routing.
  Source-only runtime smoke also covered missing `dist` and symlink escape.
- Browser grid, text and structured searches, mood selection, details, copied
  media URL and `?gif=` deep links; application requests used only the narrow API.
- Primary ingestion created a fixture table and stored one expected document
  with a sentinel complete Authorization header. Missing authentication failed
  with 401; CR/LF configuration was rejected without printing its value.
- Deployment shell syntax and Makefile command expansion.

Docker is not installed on the verification workstation, so image build,
nonroot container execution and published-port smoke remain unverified.
No local Antfly was listening on port 8080 and no managed endpoint was supplied:
fixture searches are not proof of real semantic inference or model readiness.
No deployment script, live database mutation, Cloud provisioning, DNS change or
Colony modification was performed. The checked-in routing change does not prove
containment of any unapplied live configuration.
