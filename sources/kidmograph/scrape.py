#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""
Scrape GIFs/videos from kidmograph.com/personal using Playwright.

Wix Pro Gallery loads content dynamically via JS, so we need a real browser.
Discovers media URLs, downloads to media/, and maintains manifest.json.

Usage:
    uv run sources/kidmograph/scrape.py
    uv run sources/kidmograph/scrape.py --limit 10
    uv run sources/kidmograph/scrape.py --skip-download
"""

import argparse
import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen, Request

SOURCE_NAME = "kidmograph"
SOURCE_URL = "https://www.kidmograph.com/personal"
SOURCE_DIR = Path(__file__).parent
MEDIA_DIR = SOURCE_DIR / "media"
MANIFEST_PATH = SOURCE_DIR / "manifest.json"


def make_id(url: str) -> str:
    """Generate deterministic ID: 2-char prefix + SHA-256 hash prefix."""
    h = hashlib.sha256(url.encode()).hexdigest()[:8]
    return f"km_{h}"


def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        with open(MANIFEST_PATH) as f:
            return json.load(f)
    return {
        "source": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "scraped_at": None,
        "items": [],
    }


def save_manifest(manifest: dict) -> None:
    tmp = MANIFEST_PATH.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(manifest, f, indent=2)
    tmp.rename(MANIFEST_PATH)


def normalize_wix_url(url: str) -> str:
    """Strip Wix image service resize/fill params to get full-res URL."""
    # Wix pattern: .../media/<id>/v1/fill/w_X,h_Y/...
    # We want just: https://static.wixstatic.com/media/<id>
    match = re.match(r"(https?://static\.wixstatic\.com/media/[^/]+)", url)
    if match:
        return match.group(1)
    # Video URLs: https://video.wixstatic.com/video/<id>/...
    match = re.match(r"(https?://video\.wixstatic\.com/video/[^/]+)", url)
    if match:
        return match.group(1)
    return url


def detect_format(url: str, tag_name: str) -> str:
    """Guess format from URL and element type."""
    lower = url.lower()
    if any(ext in lower for ext in [".mp4", "/mp4/"]):
        return "mp4"
    if any(ext in lower for ext in [".webm", "/webm/"]):
        return "webm"
    if tag_name in ("video", "source"):
        return "mp4"
    return "gif"


def scrape(limit: int = 0) -> list[dict]:
    """Use Playwright to discover all media items on the page."""
    from playwright.sync_api import sync_playwright

    items = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        print(f"Loading {SOURCE_URL}...")
        page.goto(SOURCE_URL, wait_until="networkidle", timeout=60000)

        # Scroll repeatedly to trigger lazy loading of all gallery items
        print("Scrolling to load all gallery items...")
        prev_count = 0
        stable_rounds = 0
        for i in range(100):  # safety limit
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1500)

            # Count media elements
            count = page.evaluate("""() => {
                const imgs = document.querySelectorAll('img[src*="wixstatic.com/media"]');
                const vids = document.querySelectorAll('video[src*="wixstatic.com"], video source[src*="wixstatic.com"]');
                return imgs.length + vids.length;
            }""")

            if count == prev_count:
                stable_rounds += 1
                if stable_rounds >= 3:
                    break
            else:
                stable_rounds = 0
                print(f"  Found {count} media elements so far...")
            prev_count = count

        # Also try clicking "Load More" if it exists
        try:
            load_more = page.query_selector('button:has-text("Load More"), [data-testid="load-more"]')
            if load_more:
                print("Found 'Load More' button, clicking...")
                load_more.click()
                page.wait_for_timeout(3000)
                # Scroll again after load more
                for _ in range(20):
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    page.wait_for_timeout(1500)
        except Exception:
            pass  # No load more button, that's fine

        # Extract all media URLs
        media_data = page.evaluate("""() => {
            const results = [];
            const seen = new Set();

            // Images
            for (const img of document.querySelectorAll('img[src*="wixstatic.com/media"]')) {
                const src = img.src || img.getAttribute('src');
                if (src && !seen.has(src)) {
                    seen.add(src);
                    results.push({
                        url: src,
                        tag: 'img',
                        title: img.alt || '',
                    });
                }
            }

            // Videos
            for (const vid of document.querySelectorAll('video')) {
                const src = vid.src || vid.querySelector('source')?.src;
                if (src && src.includes('wixstatic.com') && !seen.has(src)) {
                    seen.add(src);
                    results.push({
                        url: src,
                        tag: 'video',
                        title: '',
                    });
                }
            }

            return results;
        }""")

        browser.close()

    # Deduplicate by normalized URL
    seen_normalized = set()
    for raw in media_data:
        normalized = normalize_wix_url(raw["url"])
        if normalized in seen_normalized:
            continue
        seen_normalized.add(normalized)

        fmt = detect_format(raw["url"], raw["tag"])
        items.append({
            "original_url": normalized,
            "page_url": SOURCE_URL,
            "title": raw["title"],
            "format": fmt,
        })

        if limit and len(items) >= limit:
            break

    print(f"Discovered {len(items)} unique media items")
    return items


def download_item(item: dict, source_dir: Path) -> bool:
    """Download a single media item. Returns True on success."""
    local_path = source_dir / item["local_file"]
    if local_path.exists():
        return True

    url = item["original_url"]
    try:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=30) as resp:
            data = resp.read()

            # Check content type to detect format mismatches
            content_type = resp.headers.get("Content-Type", "")
            if "video/mp4" in content_type and item["format"] == "gif":
                item["format"] = "mp4"
                new_file = item["local_file"].rsplit(".", 1)[0] + ".mp4"
                item["local_file"] = new_file
                local_path = source_dir / new_file

            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(data)

            item["file_size_bytes"] = len(data)
            print(f"  Downloaded: {local_path.name} ({len(data)} bytes)")
            return True
    except Exception as e:
        print(f"  Download error for {url}: {e}", file=sys.stderr)
        item["download_error"] = str(e)
        return False


def main():
    parser = argparse.ArgumentParser(description=f"Scrape GIFs from {SOURCE_NAME}")
    parser.add_argument("--limit", type=int, default=0, help="Limit items to scrape (0=all)")
    parser.add_argument("--skip-download", action="store_true", help="Only discover URLs")
    parser.add_argument("--force", action="store_true", help="Re-scrape even if manifest exists")
    parser.add_argument("--download-delay", type=float, default=0.5,
                        help="Delay between downloads in seconds (default: 0.5)")
    args = parser.parse_args()

    MEDIA_DIR.mkdir(parents=True, exist_ok=True)

    manifest = load_manifest()
    existing_urls = {item["original_url"] for item in manifest["items"]}

    # Scrape phase: discover new items
    if args.force or not manifest["scraped_at"]:
        new_items = scrape(limit=args.limit)

        added = 0
        for raw in new_items:
            if raw["original_url"] in existing_urls:
                continue

            item_id = make_id(raw["original_url"])
            ext = raw["format"]
            item = {
                "id": item_id,
                "original_url": raw["original_url"],
                "page_url": raw["page_url"],
                "title": raw.get("title", ""),
                "local_file": f"media/{item_id}.{ext}",
                "format": ext,
                "downloaded": False,
                "described": False,
            }
            manifest["items"].append(item)
            existing_urls.add(raw["original_url"])
            added += 1

        manifest["scraped_at"] = datetime.now(timezone.utc).isoformat()
        print(f"Added {added} new items to manifest")
    else:
        print(f"Manifest already exists with {len(manifest['items'])} items (use --force to re-scrape)")

    # Download phase
    if not args.skip_download:
        to_download = [i for i in manifest["items"] if not i["downloaded"]]
        print(f"Downloading {len(to_download)} items...")
        for i, item in enumerate(to_download):
            if download_item(item, SOURCE_DIR):
                item["downloaded"] = True
            # Save manifest periodically
            if (i + 1) % 10 == 0:
                save_manifest(manifest)
            if args.download_delay > 0:
                time.sleep(args.download_delay)

    save_manifest(manifest)

    downloaded = sum(1 for i in manifest["items"] if i["downloaded"])
    described = sum(1 for i in manifest["items"] if i["described"])
    print(f"\nManifest: {len(manifest['items'])} items, {downloaded} downloaded, {described} described")


if __name__ == "__main__":
    main()
