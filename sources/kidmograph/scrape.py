#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""
Discover GIFs/videos from kidmograph.com/personal using Playwright.

Wix Pro Gallery loads content dynamically via JS, so we need a real browser.
Discovers media URLs and writes them to manifest.json. Does NOT download media —
that's handled by pipeline/upload_r2.py which streams directly to R2.

Usage:
    uv run sources/kidmograph/scrape.py
    uv run sources/kidmograph/scrape.py --limit 10
    uv run sources/kidmograph/scrape.py --force
"""

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

SOURCE_NAME = "kidmograph"
SOURCE_URL = "https://www.kidmograph.com/personal"
SOURCE_DIR = Path(__file__).parent
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
    match = re.match(r"(https?://static\.wixstatic\.com/media/[^/]+)", url)
    if match:
        return match.group(1)
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
                for _ in range(20):
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    page.wait_for_timeout(1500)
        except Exception:
            pass

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


def main():
    parser = argparse.ArgumentParser(description=f"Discover GIFs from {SOURCE_NAME}")
    parser.add_argument("--limit", type=int, default=0, help="Limit items to discover (0=all)")
    parser.add_argument("--force", action="store_true", help="Re-scrape even if manifest exists")
    args = parser.parse_args()

    manifest = load_manifest()
    existing_urls = {item["original_url"] for item in manifest["items"]}

    if args.force or not manifest["scraped_at"]:
        new_items = scrape(limit=args.limit)

        added = 0
        for raw in new_items:
            if raw["original_url"] in existing_urls:
                continue

            item_id = make_id(raw["original_url"])
            item = {
                "id": item_id,
                "original_url": raw["original_url"],
                "page_url": raw["page_url"],
                "title": raw.get("title", ""),
                "format": raw["format"],
            }
            manifest["items"].append(item)
            existing_urls.add(raw["original_url"])
            added += 1

        manifest["scraped_at"] = datetime.now(timezone.utc).isoformat()
        save_manifest(manifest)
        print(f"Added {added} new items to manifest ({len(manifest['items'])} total)")
    else:
        print(f"Manifest already exists with {len(manifest['items'])} items (use --force to re-scrape)")


if __name__ == "__main__":
    main()
