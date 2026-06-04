#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "python-dotenv"]
# ///
"""
Lift-and-shift an Antfly table into Antfly Cloud without re-embedding content.

This is intentionally written as a customer-facing migration path:
- read from the source Antfly HTTP API
- create a Cloud destination table through the public API
- import stored vectors as external embeddings via _embeddings

Typical flow:
    antfly-cloud login
    antfly-cloud antfly env <instance>          # copy destination URL/token exports

    uv run scripts/migrate_to_antfly_cloud.py \
      --source-url http://localhost:8080/api/v1 \
      --dest-url "$ANTFLY_URL" \
      --dest-bearer-token "$ANTFLY_TOKEN" \
      --table honeycomb \
      --export-path .migration/honeycomb.ndjson \
      --yes

The script never calls a managed embedder for documents. Destination vector indexes
are created with external=true, and vectors are copied from source _embeddings.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from dotenv import load_dotenv

load_dotenv()

DEFAULT_TABLE = "honeycomb"
DEFAULT_BATCH_SIZE = 100
DEFAULT_SCAN_LIMIT = 500
DEFAULT_TIMEOUT = 60.0


class MigrationError(RuntimeError):
    """A user-actionable migration failure."""


@dataclass(frozen=True)
class Record:
    key: str
    doc: dict[str, Any]


class AntflyAPI:
    """Small public-API wrapper that works with /api/v1, /db/v1, or root URLs."""

    def __init__(
        self,
        base_url: str,
        *,
        bearer_token: str | None = None,
        api_key: tuple[str, str] | None = None,
        basic_auth: tuple[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        if not base_url:
            raise MigrationError("missing Antfly API URL")
        self.base_url = base_url.rstrip("/")
        self.path_prefix = "" if self.base_url.endswith(("/api/v1", "/db/v1")) else "/api/v1"

        headers: dict[str, str] = {}
        auth = None
        if bearer_token:
            headers["Authorization"] = f"Bearer {bearer_token}"
        elif api_key:
            encoded = base64.b64encode(f"{api_key[0]}:{api_key[1]}".encode()).decode()
            headers["Authorization"] = f"ApiKey {encoded}"
        elif basic_auth:
            auth = basic_auth

        self.client = httpx.Client(
            base_url=self.base_url,
            headers=headers,
            auth=auth,
            timeout=httpx.Timeout(timeout),
        )

    def close(self) -> None:
        self.client.close()

    def _path(self, path: str) -> str:
        if not path.startswith("/"):
            path = "/" + path
        return self.path_prefix + path

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        resp = self.client.request(method, self._path(path), **kwargs)
        if resp.status_code >= 400:
            raise MigrationError(f"{method} {self._path(path)} failed ({resp.status_code}): {resp.text[:1000]}")
        return resp

    def request_ok_or_exists(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        resp = self.client.request(method, self._path(path), **kwargs)
        if resp.status_code in (200, 201, 204, 409):
            return resp
        if "already exists" in resp.text.lower():
            return resp
        raise MigrationError(f"{method} {self._path(path)} failed ({resp.status_code}): {resp.text[:1000]}")

    def get_table(self, table: str) -> dict[str, Any] | None:
        resp = self.client.get(self._path(f"/tables/{quote(table, safe='')}"))
        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            raise MigrationError(f"GET table failed ({resp.status_code}): {resp.text[:1000]}")
        return resp.json()

    def create_table(self, table: str, body: dict[str, Any]) -> bool:
        resp = self.request_ok_or_exists("POST", f"/tables/{quote(table, safe='')}", json=body)
        return resp.status_code != 409 and "already exists" not in resp.text.lower()

    def batch_insert(self, table: str, inserts: dict[str, dict[str, Any]]) -> None:
        self.request("POST", f"/tables/{quote(table, safe='')}/batch", json={"inserts": inserts})

    def scan_records(
        self,
        table: str,
        *,
        fields: list[str],
        limit: int,
        start_after: str | None = None,
    ) -> Iterator[Record]:
        """Stream records using the public lookup scan endpoint."""
        cursor = start_after
        while True:
            body: dict[str, Any] = {"fields": fields, "limit": limit}
            if cursor:
                body["from"] = cursor
                body["inclusive_from"] = False

            resp = self.request("POST", f"/tables/{quote(table, safe='')}/lookup", json=body)
            seen = 0
            last_key = cursor
            for raw in resp.text.splitlines():
                if not raw.strip():
                    continue
                obj = json.loads(raw)
                rec = normalize_scan_line(obj)
                seen += 1
                last_key = rec.key
                yield rec

            if seen == 0 or seen < limit:
                break
            cursor = last_key

    def query_count(self, table: str) -> int | None:
        resp = self.request("POST", f"/tables/{quote(table, safe='')}/query", json={"limit": 1})
        data = resp.json()
        return data.get("responses", [{}])[0].get("hits", {}).get("total")

    def get_by_key(self, table: str, key: str, *, fields: list[str] | None = None) -> dict[str, Any] | None:
        path = f"/tables/{quote(table, safe='')}/{quote(key, safe='')}"
        params = {"fields": ",".join(fields)} if fields else None
        resp = self.client.get(self._path(path), params=params)
        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            raise MigrationError(f"GET key {key!r} failed ({resp.status_code}): {resp.text[:1000]}")
        return resp.json()

    def query_with_embedding(self, table: str, index: str, vector: list[float], limit: int = 3) -> dict[str, Any]:
        resp = self.request(
            "POST",
            f"/tables/{quote(table, safe='')}/query",
            json={"embeddings": {index: vector}, "indexes": [index], "limit": limit},
        )
        return resp.json()


def normalize_scan_line(obj: Mapping[str, Any]) -> Record:
    key = obj.get("key") or obj.get("id") or obj.get("_id")
    if not isinstance(key, str) or not key:
        raise MigrationError(f"scan result is missing a string key: {obj!r}")

    if isinstance(obj.get("fields"), dict):
        doc = dict(obj["fields"])
    elif isinstance(obj.get("source"), dict):
        doc = dict(obj["source"])
    elif isinstance(obj.get("_source"), dict):
        doc = dict(obj["_source"])
    else:
        doc = {k: v for k, v in obj.items() if k not in {"key", "id", "_id"}}
    return Record(key=key, doc=doc)


def record_to_jsonl(rec: Record) -> str:
    return json.dumps({"key": rec.key, "doc": rec.doc}, ensure_ascii=False, separators=(",", ":"))


def record_from_jsonl(line: str) -> Record:
    obj = json.loads(line)
    return Record(key=obj["key"], doc=obj["doc"])


def iter_export(path: Path) -> Iterator[Record]:
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield record_from_jsonl(line)


def export_records(
    source: AntflyAPI,
    table: str,
    export_path: Path,
    *,
    fields: list[str],
    scan_limit: int,
    resume: bool,
    max_records: int,
) -> tuple[int, str | None]:
    export_path.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if resume and export_path.exists() else "w"
    last_key = find_last_exported_key(export_path) if mode == "a" else None
    count = 0

    print(f"Exporting table {table!r} to {export_path}...")
    if last_key:
        print(f"  resuming after key: {last_key}")

    with export_path.open(mode, encoding="utf-8") as out:
        for rec in source.scan_records(table, fields=fields, limit=scan_limit, start_after=last_key):
            out.write(record_to_jsonl(rec) + "\n")
            count += 1
            last_key = rec.key
            if count % 1000 == 0:
                print(f"  exported {count:,} records in this run (last={last_key})")
            if max_records and count >= max_records:
                break

    print(f"Export complete: {count:,} records exported in this run")
    return count, last_key


def find_last_exported_key(path: Path) -> str | None:
    if not path.exists() or path.stat().st_size == 0:
        return None
    last = None
    with path.open("rb") as f:
        for raw in f:
            if raw.strip():
                last = raw
    if not last:
        return None
    return record_from_jsonl(last.decode("utf-8")).key


def load_export_stats(export_path: Path) -> dict[str, Any]:
    count = 0
    first_key = None
    last_key = None
    index_dims: dict[str, int] = {}
    missing_embeddings = 0
    sample_keys: list[str] = []
    digest = hashlib.sha256()

    for rec in iter_export(export_path):
        count += 1
        first_key = first_key or rec.key
        last_key = rec.key
        if len(sample_keys) < 10:
            sample_keys.append(rec.key)
        digest.update(rec.key.encode())
        digest.update(b"\0")
        embeddings = rec.doc.get("_embeddings")
        if not isinstance(embeddings, dict) or not embeddings:
            missing_embeddings += 1
            continue
        for name, value in embeddings.items():
            dim = embedding_dimension(value)
            if dim:
                index_dims[name] = max(index_dims.get(name, 0), dim)

    return {
        "count": count,
        "first_key": first_key,
        "last_key": last_key,
        "index_dims": index_dims,
        "missing_embeddings": missing_embeddings,
        "sample_keys": sample_keys,
        "key_sha256": digest.hexdigest(),
    }


def embedding_dimension(value: Any) -> int | None:
    if isinstance(value, list):
        return len(value)
    if isinstance(value, str):
        try:
            return len(base64.b64decode(value)) // 4
        except Exception:
            return None
    if isinstance(value, dict):
        if isinstance(value.get("values"), list):
            return len(value["values"])
        if isinstance(value.get("packed_values"), str):
            try:
                return len(base64.b64decode(value["packed_values"])) // 4
            except Exception:
                return None
        # Sparse token-weight map; no dense dimension.
        return None
    return None


def infer_external_indexes(
    source_table: dict[str, Any] | None,
    stats: dict[str, Any],
    *,
    only_indexes: list[str] | None,
) -> dict[str, dict[str, Any]]:
    dims: dict[str, int] = dict(stats["index_dims"])
    source_indexes = (source_table or {}).get("indexes") if source_table else None
    if isinstance(source_indexes, dict):
        for name, cfg in source_indexes.items():
            if not isinstance(cfg, dict):
                continue
            dim = cfg.get("dimension")
            if isinstance(dim, int) and dim > 0:
                dims.setdefault(name, dim)

    names = only_indexes or sorted(dims)
    if not names:
        raise MigrationError(
            "could not infer any stored dense _embeddings. Make sure the source scan includes _embeddings "
            "and that the source table has stored vectors."
        )

    indexes: dict[str, dict[str, Any]] = {}
    for name in names:
        dim = dims.get(name)
        if not dim:
            raise MigrationError(f"could not infer dense dimension for index {name!r}")
        cfg: dict[str, Any] = {"type": "embeddings", "external": True, "dimension": dim}
        src_cfg = source_indexes.get(name) if isinstance(source_indexes, dict) else None
        if isinstance(src_cfg, dict) and src_cfg.get("distance_metric"):
            cfg["distance_metric"] = src_cfg["distance_metric"]
        indexes[name] = cfg
    return indexes


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    manifest_path = path.with_suffix(path.suffix + ".manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote manifest: {manifest_path}")


def create_destination_table(
    dest: AntflyAPI,
    dest_table: str,
    *,
    indexes: dict[str, dict[str, Any]],
    source_table: dict[str, Any] | None,
    num_shards: int | None,
    force_external_only: bool = True,
) -> None:
    existing = dest.get_table(dest_table)
    if existing:
        print(f"Destination table {dest_table!r} already exists; will import into it")
        return

    body: dict[str, Any] = {
        "description": "Lift-and-shift import; vectors supplied as external _embeddings.",
        "indexes": indexes,
    }
    if num_shards is not None:
        body["num_shards"] = num_shards
    elif isinstance(source_table, dict):
        shards = source_table.get("shards")
        if isinstance(shards, dict) and shards:
            # Use the same shard count as a customer-visible default, not internal shard IDs.
            body["num_shards"] = len(shards)

    schema = source_table.get("schema") if isinstance(source_table, dict) else None
    if schema:
        body["schema"] = schema

    if force_external_only:
        for name, cfg in body["indexes"].items():
            if cfg.get("external") is not True:
                raise MigrationError(f"destination index {name!r} is not external=true")

    print(f"Creating destination table {dest_table!r} with external indexes: {', '.join(indexes)}")
    created = dest.create_table(dest_table, body)
    print("Created destination table" if created else "Destination table already existed")


def import_records(
    dest: AntflyAPI,
    dest_table: str,
    export_path: Path,
    *,
    batch_size: int,
    require_embeddings: bool,
    only_indexes: list[str] | None,
    max_records: int,
) -> int:
    imported = 0
    batch: dict[str, dict[str, Any]] = {}
    start = time.time()

    print(f"Importing {export_path} into destination table {dest_table!r}...")
    for rec in iter_export(export_path):
        if max_records and imported + len(batch) >= max_records:
            break
        doc = dict(rec.doc)
        embeddings = doc.get("_embeddings")
        if only_indexes and isinstance(embeddings, dict):
            doc["_embeddings"] = {k: v for k, v in embeddings.items() if k in set(only_indexes)}
            embeddings = doc["_embeddings"]
        if require_embeddings and (not isinstance(embeddings, dict) or not embeddings):
            raise MigrationError(f"record {rec.key!r} is missing _embeddings; refusing to re-embed or import partial data")

        batch[rec.key] = doc
        if len(batch) >= batch_size:
            dest.batch_insert(dest_table, batch)
            imported += len(batch)
            batch = {}
            print_progress(imported, start)
            if max_records and imported >= max_records:
                break

    if batch and (not max_records or imported < max_records):
        if max_records:
            remaining = max_records - imported
            batch = dict(list(batch.items())[:remaining])
        dest.batch_insert(dest_table, batch)
        imported += len(batch)
        print_progress(imported, start)

    print(f"\nImport complete: {imported:,} records")
    return imported


def print_progress(count: int, start: float) -> None:
    elapsed = max(time.time() - start, 0.001)
    print(f"\r  imported {count:,} ({count / elapsed:.1f}/s)", end="", flush=True)


def verify_import(
    source_stats: dict[str, Any],
    dest: AntflyAPI,
    dest_table: str,
    export_path: Path,
    *,
    sample_size: int,
) -> None:
    print("Verifying destination...")
    dest_count = dest.query_count(dest_table)
    if dest_count is not None:
        print(f"  destination query count: {dest_count:,}")
        if dest_count < source_stats["count"]:
            raise MigrationError(f"destination count {dest_count} is less than exported count {source_stats['count']}")

    checked = 0
    vector_query_done = False
    for rec in iter_export(export_path):
        doc = dest.get_by_key(dest_table, rec.key, fields=["_embeddings", "gif_url", "combined_text", "tags", "rating"])
        if doc is None:
            raise MigrationError(f"sample key missing from destination: {rec.key}")
        exported_embeddings = rec.doc.get("_embeddings")
        dest_embeddings = doc.get("_embeddings")
        if isinstance(exported_embeddings, dict) and exported_embeddings:
            if not isinstance(dest_embeddings, dict) or not dest_embeddings:
                raise MigrationError(f"sample key {rec.key!r} is missing destination _embeddings")
            if not vector_query_done:
                name, vector = first_dense_embedding(exported_embeddings)
                if name and vector:
                    data = dest.query_with_embedding(dest_table, name, vector, limit=3)
                    hits = data.get("responses", [{}])[0].get("hits", {}).get("hits", [])
                    if not hits:
                        raise MigrationError("sample vector query returned no hits")
                    vector_query_done = True
        checked += 1
        if checked >= sample_size:
            break

    print(f"  verified {checked} sampled keys")
    if vector_query_done:
        print("  verified sampled vector query")


def first_dense_embedding(embeddings: Mapping[str, Any]) -> tuple[str | None, list[float] | None]:
    for name, value in embeddings.items():
        if isinstance(value, list) and value and all(isinstance(x, (int, float)) for x in value):
            return name, [float(x) for x in value]
    return None, None


def parse_basic(value: str | None) -> tuple[str, str] | None:
    if not value:
        return None
    if ":" not in value:
        raise MigrationError("basic auth must be USER:PASSWORD")
    user, password = value.split(":", 1)
    return user, password


def parse_api_key(key_id: str | None, key_secret: str | None) -> tuple[str, str] | None:
    if key_id or key_secret:
        if not key_id or not key_secret:
            raise MigrationError("API key auth requires both id and secret")
        return key_id, key_secret
    return None


def parse_indexes(raw: str | None) -> list[str] | None:
    if not raw:
        return None
    return [part.strip() for part in raw.split(",") if part.strip()]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lift-and-shift an Antfly table into Antfly Cloud without re-embedding")
    parser.add_argument("--source-url", default=os.environ.get("SOURCE_ANTFLY_URL") or "http://localhost:8080/api/v1")
    parser.add_argument("--dest-url", default=os.environ.get("DEST_ANTFLY_URL") or os.environ.get("ANTFLY_URL"))
    parser.add_argument("--table", default=os.environ.get("INGEST_TABLE", DEFAULT_TABLE), help="Source table name")
    parser.add_argument("--dest-table", help="Destination table name (default: same as --table)")
    parser.add_argument("--export-path", type=Path, default=Path(".migration/honeycomb.ndjson"))
    parser.add_argument("--indexes", help="Comma-separated embedding indexes to preserve (default: all dense indexes in _embeddings)")
    parser.add_argument("--fields", default="*,_embeddings", help="Comma-separated scan projection; default asks for full document fields plus stored vectors")
    parser.add_argument("--scan-limit", type=int, default=DEFAULT_SCAN_LIMIT)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--num-shards", type=int, help="Destination shard count override")
    parser.add_argument("--limit", type=int, default=0, help="Limit records for rehearsal (0=all)")
    parser.add_argument("--resume-export", action="store_true", help="Append export after the last exported key")
    parser.add_argument("--skip-export", action="store_true", help="Use an existing --export-path")
    parser.add_argument("--skip-create", action="store_true", help="Do not create destination table")
    parser.add_argument("--skip-import", action="store_true", help="Export/create only")
    parser.add_argument("--verify", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--sample-size", type=int, default=10)
    parser.add_argument("--allow-missing-embeddings", action="store_true", help="Allow records without _embeddings (still does not re-embed)")
    parser.add_argument("--dry-run", action="store_true", help="Export/analyze only; do not create or import")
    parser.add_argument("--yes", "-y", action="store_true", help="Do not prompt before destination writes")

    # Auth. Defaults intentionally align with likely antfly-cloud env exports.
    parser.add_argument("--source-bearer-token", default=os.environ.get("SOURCE_ANTFLY_TOKEN"))
    parser.add_argument("--dest-bearer-token", default=os.environ.get("DEST_ANTFLY_TOKEN") or os.environ.get("ANTFLY_TOKEN"))
    parser.add_argument("--source-basic", default=os.environ.get("SOURCE_ANTFLY_BASIC"), help="USER:PASSWORD")
    parser.add_argument("--dest-basic", default=os.environ.get("DEST_ANTFLY_BASIC"), help="USER:PASSWORD")
    parser.add_argument("--source-api-key-id", default=os.environ.get("SOURCE_ANTFLY_API_KEY_ID"))
    parser.add_argument("--source-api-key-secret", default=os.environ.get("SOURCE_ANTFLY_API_KEY_SECRET"))
    parser.add_argument("--dest-api-key-id", default=os.environ.get("DEST_ANTFLY_API_KEY_ID") or os.environ.get("ANTFLY_API_KEY_ID"))
    parser.add_argument("--dest-api-key-secret", default=os.environ.get("DEST_ANTFLY_API_KEY_SECRET") or os.environ.get("ANTFLY_API_KEY_SECRET"))
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.scan_limit <= 0 or args.batch_size <= 0:
        parser.error("--scan-limit and --batch-size must be positive")
    if not args.dest_url and not args.dry_run and not args.skip_import:
        parser.error("--dest-url is required for create/import; use antfly-cloud antfly env <instance> or pass --dest-url")

    dest_table = args.dest_table or args.table
    only_indexes = parse_indexes(args.indexes)
    fields = [part.strip() for part in args.fields.split(",") if part.strip()]
    if "_embeddings" not in fields:
        fields.append("_embeddings")

    source = AntflyAPI(
        args.source_url,
        bearer_token=args.source_bearer_token,
        api_key=parse_api_key(args.source_api_key_id, args.source_api_key_secret),
        basic_auth=parse_basic(args.source_basic),
    )
    dest: AntflyAPI | None = None
    try:
        if not args.skip_export:
            export_records(
                source,
                args.table,
                args.export_path,
                fields=fields,
                scan_limit=args.scan_limit,
                resume=args.resume_export,
                max_records=args.limit,
            )
        elif not args.export_path.exists():
            raise MigrationError(f"--skip-export was set but export path does not exist: {args.export_path}")

        stats = load_export_stats(args.export_path)
        print("Export stats:")
        print(json.dumps(stats, indent=2, sort_keys=True))
        if stats["count"] == 0:
            raise MigrationError("export contains zero records")
        if stats["missing_embeddings"] and not args.allow_missing_embeddings:
            raise MigrationError(
                f"{stats['missing_embeddings']} exported records are missing _embeddings. "
                "Refusing because this migration must preserve vectors and not re-embed."
            )

        source_table = source.get_table(args.table)
        indexes = infer_external_indexes(source_table, stats, only_indexes=only_indexes)
        manifest = {
            "source_url": args.source_url,
            "source_table": args.table,
            "dest_url": args.dest_url,
            "dest_table": dest_table,
            "export_path": str(args.export_path),
            "stats": stats,
            "destination_indexes": indexes,
            "does_not_reembed": True,
        }
        write_manifest(args.export_path, manifest)

        if args.dry_run or args.skip_import:
            print("Dry-run/export-only complete; no destination writes performed.")
            return 0

        assert args.dest_url
        if not args.yes:
            answer = input(f"Create/import {stats['count']:,} records into destination table {dest_table!r}? [y/N] ")
            if answer.lower() != "y":
                print("Aborted before destination writes.")
                return 0

        dest = AntflyAPI(
            args.dest_url,
            bearer_token=args.dest_bearer_token,
            api_key=parse_api_key(args.dest_api_key_id, args.dest_api_key_secret),
            basic_auth=parse_basic(args.dest_basic),
        )
        if not args.skip_create:
            create_destination_table(
                dest,
                dest_table,
                indexes=indexes,
                source_table=source_table,
                num_shards=args.num_shards,
            )

        imported = import_records(
            dest,
            dest_table,
            args.export_path,
            batch_size=args.batch_size,
            require_embeddings=not args.allow_missing_embeddings,
            only_indexes=only_indexes,
            max_records=args.limit,
        )
        if imported == 0:
            raise MigrationError("import wrote zero records")

        if args.verify:
            verify_import(stats, dest, dest_table, args.export_path, sample_size=args.sample_size)

        print("Migration complete. No document re-embedding was performed.")
        return 0
    except (httpx.HTTPError, MigrationError, OSError, json.JSONDecodeError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    finally:
        source.close()
        if dest:
            dest.close()


if __name__ == "__main__":
    raise SystemExit(main())
