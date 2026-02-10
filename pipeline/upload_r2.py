#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3"]
# ///
"""
Upload GIF media to Cloudflare R2 storage.

Handles two modes:
- Source manifests: reads sources/{name}/manifest.json, uploads from media/ dir
- TGIF dataset: reads descriptions JSONL, downloads from Tumblr URLs, uploads to R2

Bucket path structure:
  tgif/{doc_id}.gif
  sources/{source_name}/{item_id}.gif

Usage:
    uv run pipeline/upload_r2.py --source kidmograph
    uv run pipeline/upload_r2.py --tgif --jsonl gif_descriptions.jsonl
    uv run pipeline/upload_r2.py --all-sources
"""

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from urllib.request import urlopen, Request

import boto3
from botocore.exceptions import ClientError

# Config
SOURCES_DIR = Path(__file__).parent.parent / "sources"
BUCKET_NAME = "honeycomb-media"


def get_s3_client():
    """Create S3-compatible client for Cloudflare R2."""
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )


def get_public_url(key: str) -> str:
    """Get public CDN URL for an R2 object."""
    base = os.environ.get("R2_PUBLIC_URL", "https://media.honeycomb.rowan.earth")
    return f"{base.rstrip('/')}/{key}"


def object_exists(s3, key: str) -> bool:
    """Check if an object already exists in R2 (idempotent uploads)."""
    try:
        s3.head_object(Bucket=BUCKET_NAME, Key=key)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "404":
            return False
        raise


def upload_file(s3, key: str, data: bytes, content_type: str = "image/gif") -> str:
    """Upload data to R2 and return the public URL."""
    s3.put_object(
        Bucket=BUCKET_NAME,
        Key=key,
        Body=data,
        ContentType=content_type,
    )
    return get_public_url(key)


def fix_tumblr_url(url: str) -> str:
    """Update old Tumblr CDN URLs to new domain."""
    for old in ["38.media", "33.media", "31.media"]:
        url = url.replace(f"{old}.tumblr.com", "64.media.tumblr.com")
    return url


def download_url(url: str, timeout: int = 30) -> bytes | None:
    """Download a file from URL and return bytes."""
    try:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=timeout) as resp:
            if "assets.tumblr.com/images/media_violation/" in resp.url:
                return None
            return resp.read()
    except Exception as e:
        print(f"  Download error: {e}", file=sys.stderr)
        return None


def doc_id_from_url(url: str) -> str:
    """Generate document ID from URL (matches Go ingest logic)."""
    h = hashlib.md5(url.encode()).hexdigest()[:16]
    return f"gif_{h}"


# --- Source upload ---

def load_manifest(source_dir: Path) -> dict:
    with open(source_dir / "manifest.json") as f:
        return json.load(f)


def save_manifest(source_dir: Path, manifest: dict) -> None:
    tmp = (source_dir / "manifest.json").with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(manifest, f, indent=2)
    tmp.rename(source_dir / "manifest.json")


def upload_source(s3, source_name: str) -> int:
    """Upload media for a source from its manifest. Returns count uploaded."""
    source_dir = SOURCES_DIR / source_name
    manifest = load_manifest(source_dir)

    items = [i for i in manifest["items"] if i.get("downloaded")]
    if not items:
        print(f"  No downloaded items for {source_name}")
        return 0

    uploaded = 0
    skipped = 0
    start = time.time()

    for item in items:
        item_id = item["id"]
        local_file = source_dir / item["local_file"]
        fmt = item.get("format", "gif")
        ext = fmt if fmt in ("gif", "mp4", "webm") else "gif"
        key = f"sources/{source_name}/{item_id}.{ext}"

        if item.get("r2_url"):
            skipped += 1
            continue

        if object_exists(s3, key):
            item["r2_url"] = get_public_url(key)
            skipped += 1
            continue

        if not local_file.exists():
            print(f"  File not found: {local_file}", file=sys.stderr)
            continue

        data = local_file.read_bytes()
        content_type = f"image/{ext}" if ext == "gif" else f"video/{ext}"
        url = upload_file(s3, key, data, content_type)
        item["r2_url"] = url
        uploaded += 1

        done = uploaded + skipped
        if done % 10 == 0 or done == len(items):
            elapsed = time.time() - start
            rate = done / elapsed if elapsed > 0 else 0
            print(f"\r  [{source_name}] {uploaded} uploaded, {skipped} skipped, "
                  f"{done}/{len(items)} ({rate:.1f}/sec)", end="", flush=True)

    # Save manifest with r2_url fields
    save_manifest(source_dir, manifest)
    print()
    return uploaded


# --- TGIF upload ---

def upload_tgif(s3, jsonl_path: str) -> dict[str, str]:
    """Upload TGIF GIFs to R2. Returns {original_url: r2_url} mapping."""
    url_map: dict[str, str] = {}

    with open(jsonl_path) as f:
        lines = f.readlines()

    uploaded = 0
    skipped = 0
    failed = 0
    start = time.time()

    for line in lines:
        desc = json.loads(line)
        url = fix_tumblr_url(desc["url"])
        doc_id = desc.get("id") or doc_id_from_url(url)
        key = f"tgif/{doc_id}.gif"

        if object_exists(s3, key):
            url_map[url] = get_public_url(key)
            skipped += 1
        else:
            data = download_url(url)
            if data is None:
                failed += 1
                continue
            r2_url = upload_file(s3, key, data)
            url_map[url] = r2_url
            uploaded += 1

        done = uploaded + skipped + failed
        if done % 10 == 0 or done == len(lines):
            elapsed = time.time() - start
            rate = done / elapsed if elapsed > 0 else 0
            print(f"\r  [tgif] {uploaded} uploaded, {skipped} existing, {failed} failed, "
                  f"{done}/{len(lines)} ({rate:.1f}/sec)", end="", flush=True)

    print()
    print(f"TGIF upload complete: {uploaded} uploaded, {skipped} existing, {failed} failed")
    return url_map


def find_sources() -> list[str]:
    """Find all source directories with a manifest.json."""
    sources = []
    if not SOURCES_DIR.exists():
        return sources
    for d in sorted(SOURCES_DIR.iterdir()):
        if d.is_dir() and not d.name.startswith("_") and (d / "manifest.json").exists():
            sources.append(d.name)
    return sources


def main():
    parser = argparse.ArgumentParser(description="Upload GIF media to Cloudflare R2")
    parser.add_argument("--source", help="Upload media for a specific source")
    parser.add_argument("--all-sources", action="store_true", help="Upload all sources")
    parser.add_argument("--tgif", action="store_true", help="Upload TGIF GIFs")
    parser.add_argument("--jsonl", default="gif_descriptions.jsonl", help="TGIF descriptions JSONL")
    args = parser.parse_args()

    if not any([args.source, args.all_sources, args.tgif]):
        parser.error("Specify --source NAME, --all-sources, or --tgif")

    # Validate env vars
    for var in ["R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]:
        if var not in os.environ:
            print(f"Error: {var} environment variable not set", file=sys.stderr)
            sys.exit(1)

    s3 = get_s3_client()

    if args.tgif:
        if not Path(args.jsonl).exists():
            print(f"Error: {args.jsonl} not found", file=sys.stderr)
            sys.exit(1)
        print(f"Uploading TGIF GIFs from {args.jsonl}...")
        url_map = upload_tgif(s3, args.jsonl)
        # Write URL mapping for ingest to use
        map_path = Path(args.jsonl).with_suffix(".r2_urls.json")
        with open(map_path, "w") as f:
            json.dump(url_map, f, indent=2)
        print(f"URL mapping written to {map_path}")

    if args.source:
        source_dir = SOURCES_DIR / args.source
        if not (source_dir / "manifest.json").exists():
            print(f"Error: {source_dir}/manifest.json not found", file=sys.stderr)
            sys.exit(1)
        print(f"Uploading source: {args.source}")
        count = upload_source(s3, args.source)
        print(f"Uploaded {count} files for {args.source}")

    if args.all_sources:
        sources = find_sources()
        if not sources:
            print("No sources found")
            return
        print(f"Uploading {len(sources)} sources: {', '.join(sources)}")
        total = 0
        for name in sources:
            print(f"\n=== {name} ===")
            total += upload_source(s3, name)
        print(f"\nTotal uploaded: {total}")


if __name__ == "__main__":
    main()
