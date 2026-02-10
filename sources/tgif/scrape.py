#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Build a manifest from the TGIF dataset TSV file.

Reads the TSV (URL + description per line), generates manifest items in the
standard format. Does NOT download media — that's handled by
pipeline/upload_r2.py which streams directly to R2.

Usage:
    uv run sources/tgif/scrape.py --tsv ~/Documents/antfly/datasets/TGIF-Release/data/tgif-v1.0.tsv
    uv run sources/tgif/scrape.py --tsv path/to/tgif-v1.0.tsv --limit 100
"""

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

SOURCE_NAME = "tgif"
SOURCE_DIR = Path(__file__).parent
MANIFEST_PATH = SOURCE_DIR / "manifest.json"
DEFAULT_TSV = os.path.expanduser("~/Documents/antfly/datasets/TGIF-Release/data/tgif-v1.0.tsv")


def fix_tumblr_url(url: str) -> str:
    """Update old Tumblr CDN URLs to new domain."""
    for old in ["38.media", "33.media", "31.media"]:
        url = url.replace(f"{old}.tumblr.com", "64.media.tumblr.com")
    return url


def make_id(url: str) -> str:
    """Generate deterministic ID from URL."""
    h = hashlib.md5(url.encode()).hexdigest()[:16]
    return f"gif_{h}"


def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        with open(MANIFEST_PATH) as f:
            return json.load(f)
    return {
        "source": SOURCE_NAME,
        "source_url": "https://github.com/raingo/TGIF-Release",
        "scraped_at": None,
        "items": [],
    }


def save_manifest(manifest: dict) -> None:
    tmp = MANIFEST_PATH.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(manifest, f, indent=2)
    tmp.rename(MANIFEST_PATH)


def main():
    parser = argparse.ArgumentParser(description="Build manifest from TGIF dataset")
    parser.add_argument("--tsv", default=DEFAULT_TSV, help="Path to tgif-v1.0.tsv")
    parser.add_argument("--limit", type=int, default=0, help="Limit items (0=all)")
    parser.add_argument("--force", action="store_true", help="Re-read TSV even if manifest exists")
    args = parser.parse_args()

    if not Path(args.tsv).exists():
        print(f"Error: TSV file not found at {args.tsv}")
        print("Set --tsv to the path to tgif-v1.0.tsv")
        raise SystemExit(1)

    manifest = load_manifest()
    existing_urls = {item["original_url"] for item in manifest["items"]}

    if not args.force and manifest["scraped_at"]:
        print(f"Manifest already exists with {len(manifest['items'])} items (use --force to re-read)")
        return

    print(f"Reading TGIF dataset from {args.tsv}...")
    added = 0
    with open(args.tsv) as f:
        for line in f:
            parts = line.strip().split("\t", 1)
            if len(parts) != 2:
                continue

            url = fix_tumblr_url(parts[0])
            description = parts[1]

            if url in existing_urls:
                continue

            item_id = make_id(url)
            item = {
                "id": item_id,
                "original_url": url,
                "page_url": "",
                "title": description,
                "format": "gif",
                "attribution": "TGIF dataset",
            }
            manifest["items"].append(item)
            existing_urls.add(url)
            added += 1

            if args.limit and added >= args.limit:
                break

    manifest["scraped_at"] = datetime.now(timezone.utc).isoformat()
    save_manifest(manifest)
    print(f"Added {added} items to manifest ({len(manifest['items'])} total)")


if __name__ == "__main__":
    main()
