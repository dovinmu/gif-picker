#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["google-genai", "Pillow", "boto3"]
# ///
"""
GIF description pipeline - generates rich text descriptions using Gemini.

Usage:
    # Local GIFs (from TGIF TSV)
    uv run ingest/image-to-text/describe.py --source tgif --limit 100

    # From R2 bucket (requires R2 credentials)
    uv run ingest/image-to-text/describe.py --source r2 --limit 100

    # Resume from checkpoint
    uv run ingest/image-to-text/describe.py --source r2 --resume

    # Use custom prompt
    uv run ingest/image-to-text/describe.py --prompt my_prompt.txt --limit 10
"""

import argparse
import io
import json
import os
import sys
import threading
import time
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator
from urllib.request import urlopen, Request

from PIL import Image

# Frame extraction settings
NUM_FRAMES = 5
MAX_FRAME_DIM = 512

# Default paths
DEFAULT_PROMPT_FILE = Path(__file__).parent / "prompt.txt"
DEFAULT_OUTPUT_DIR = Path(__file__).parent / "output"
DEFAULT_TSV = Path(__file__).parent.parent.parent / "../datasets/TGIF-Release/data/tgif-v1.0.tsv"


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class GifItem:
    """A GIF to be processed."""
    id: str
    source_path: str  # R2 path, URL, or local path
    dataset: str
    original_url: str = ""
    original_description: str = ""
    attribution: str = ""


@dataclass
class ProcessingState:
    """Track processing progress for resumability."""
    processed_ids: set = field(default_factory=set)
    state_file: Path = None

    def load(self, path: Path):
        """Load state from file."""
        self.state_file = path
        if path.exists():
            with open(path) as f:
                data = json.load(f)
                self.processed_ids = set(data.get("processed_ids", []))

    def save(self):
        """Save state to file."""
        if self.state_file:
            with open(self.state_file, "w") as f:
                json.dump({"processed_ids": list(self.processed_ids)}, f)

    def mark_processed(self, item_id: str):
        """Mark an item as processed."""
        self.processed_ids.add(item_id)

    def is_processed(self, item_id: str) -> bool:
        """Check if an item has been processed."""
        return item_id in self.processed_ids


# =============================================================================
# GIF Sources - Abstract interface for different data sources
# =============================================================================

class GifSource(ABC):
    """Abstract base class for GIF data sources."""

    @abstractmethod
    def list_items(self, limit: int = 0) -> Iterator[GifItem]:
        """List available GIF items."""
        pass

    @abstractmethod
    def download(self, item: GifItem) -> bytes | None:
        """Download GIF data for an item."""
        pass


class TGIFSource(GifSource):
    """Load GIFs from TGIF dataset TSV file."""

    def __init__(self, tsv_path: Path):
        self.tsv_path = Path(tsv_path)
        if not self.tsv_path.exists():
            raise FileNotFoundError(f"TGIF TSV not found: {tsv_path}")

    def _fix_tumblr_url(self, url: str) -> str:
        """Update old Tumblr CDN URLs to new domain."""
        for old in ["38.media", "33.media", "31.media"]:
            url = url.replace(f"{old}.tumblr.com", "64.media.tumblr.com")
        return url

    def list_items(self, limit: int = 0) -> Iterator[GifItem]:
        """List GIFs from TSV file."""
        import hashlib
        count = 0
        with open(self.tsv_path) as f:
            for line in f:
                parts = line.strip().split("\t", 1)
                if len(parts) != 2:
                    continue
                url, desc = parts
                url = self._fix_tumblr_url(url)
                # Generate stable ID from URL
                url_hash = hashlib.md5(url.encode()).hexdigest()[:8]
                yield GifItem(
                    id=f"tgif_{url_hash}",
                    source_path=url,
                    dataset="tgif",
                    original_url=url,
                    original_description=desc,
                    attribution="TGIF dataset",
                )
                count += 1
                if limit and count >= limit:
                    break

    def download(self, item: GifItem) -> bytes | None:
        """Download GIF from URL."""
        try:
            req = Request(item.source_path, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=30) as resp:
                # Detect Tumblr removal redirects
                if "assets.tumblr.com/images/media_violation/" in resp.url:
                    return None
                return resp.read()
        except Exception as e:
            print(f"  Download error: {e}", file=sys.stderr)
            return None


class R2Source(GifSource):
    """Load GIFs from Cloudflare R2 bucket."""

    def __init__(self, bucket: str, prefix: str = "", endpoint_url: str = None):
        import boto3
        self.bucket = bucket
        self.prefix = prefix

        # R2 uses S3-compatible API
        self.s3 = boto3.client(
            "s3",
            endpoint_url=endpoint_url or os.environ.get("R2_ENDPOINT_URL"),
            aws_access_key_id=os.environ.get("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("R2_SECRET_ACCESS_KEY"),
        )

    def list_items(self, limit: int = 0) -> Iterator[GifItem]:
        """List GIFs in R2 bucket."""
        import hashlib
        paginator = self.s3.get_paginator("list_objects_v2")
        count = 0

        for page in paginator.paginate(Bucket=self.bucket, Prefix=self.prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if not key.lower().endswith((".gif", ".mp4", ".webm")):
                    continue

                # Extract dataset from path (e.g., "tgif/abc.gif" -> "tgif")
                parts = key.split("/")
                dataset = parts[0] if len(parts) > 1 else "unknown"

                # Generate stable ID
                key_hash = hashlib.md5(key.encode()).hexdigest()[:8]
                yield GifItem(
                    id=f"{dataset}_{key_hash}",
                    source_path=key,
                    dataset=dataset,
                    attribution=f"R2: {self.bucket}/{key}",
                )
                count += 1
                if limit and count >= limit:
                    return

    def download(self, item: GifItem) -> bytes | None:
        """Download GIF from R2."""
        try:
            response = self.s3.get_object(Bucket=self.bucket, Key=item.source_path)
            return response["Body"].read()
        except Exception as e:
            print(f"  R2 download error: {e}", file=sys.stderr)
            return None


class LocalSource(GifSource):
    """Load GIFs from local directory."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        if not self.directory.exists():
            raise FileNotFoundError(f"Directory not found: {directory}")

    def list_items(self, limit: int = 0) -> Iterator[GifItem]:
        """List GIFs in directory."""
        import hashlib
        count = 0
        for path in self.directory.rglob("*.gif"):
            path_hash = hashlib.md5(str(path).encode()).hexdigest()[:8]
            yield GifItem(
                id=f"local_{path_hash}",
                source_path=str(path),
                dataset="local",
                attribution=str(path),
            )
            count += 1
            if limit and count >= limit:
                break

    def download(self, item: GifItem) -> bytes | None:
        """Read GIF from local file."""
        try:
            with open(item.source_path, "rb") as f:
                return f.read()
        except Exception as e:
            print(f"  Local read error: {e}", file=sys.stderr)
            return None


# =============================================================================
# Gemini API Client - Abstracted for future Vertex AI support
# =============================================================================

class GeminiClient(ABC):
    """Abstract base class for Gemini API clients."""

    @abstractmethod
    def generate(self, prompt: str, images: list[bytes]) -> str | None:
        """Generate text from prompt and images."""
        pass


class GoogleGenAIClient(GeminiClient):
    """Client using google-genai SDK (current approach)."""

    def __init__(self, api_key: str = None, model: str = "gemini-2.0-flash-lite"):
        from google import genai
        self.genai = genai
        self.model = model

        # Load API key
        if api_key:
            key = api_key
        elif os.environ.get("GOOGLE_API_KEY"):
            key = os.environ["GOOGLE_API_KEY"]
        else:
            key_path = Path.home() / ".tokens/gemini_api_key"
            if key_path.exists():
                with open(key_path) as f:
                    key = f.read().strip().split()[0]
            else:
                raise ValueError("No Gemini API key found. Set GOOGLE_API_KEY or create ~/.tokens/gemini_api_key")

        self.client = genai.Client(api_key=key)

    def generate(self, prompt: str, images: list[bytes]) -> str | None:
        """Generate text from prompt and images."""
        from google.genai import types

        parts = [types.Part.from_text(text=prompt)]
        for img_data in images:
            parts.append(types.Part.from_bytes(data=img_data, mime_type="image/png"))

        try:
            response = self.client.models.generate_content(
                model=self.model,
                contents=[types.Content(parts=parts)]
            )
            return response.text
        except Exception as e:
            print(f"  API error: {e}", file=sys.stderr)
            return None


class VertexAIClient(GeminiClient):
    """Client using Vertex AI SDK (for GCP deployment)."""

    def __init__(self, project: str = None, location: str = "us-central1", model: str = "gemini-2.0-flash-lite"):
        # Placeholder for future implementation
        raise NotImplementedError(
            "Vertex AI client not yet implemented. "
            "Set up GCP project and install google-cloud-aiplatform."
        )

    def generate(self, prompt: str, images: list[bytes]) -> str | None:
        pass


# =============================================================================
# Core Processing Logic
# =============================================================================

def extract_frames(gif_data: bytes, num_frames: int = NUM_FRAMES, max_dim: int = MAX_FRAME_DIM) -> list[bytes]:
    """Extract evenly-spaced frames from a GIF as PNG bytes."""
    img = Image.open(io.BytesIO(gif_data))
    n_frames = getattr(img, "n_frames", 1)

    # Pick frame indices: evenly spaced including first and last
    if n_frames <= num_frames:
        indices = list(range(n_frames))
    else:
        indices = [round(i * (n_frames - 1) / (num_frames - 1)) for i in range(num_frames)]

    frames = []
    for idx in indices:
        img.seek(idx)
        frame = img.convert("RGBA")

        # Resize if too large
        w, h = frame.size
        if max(w, h) > max_dim:
            scale = max_dim / max(w, h)
            frame = frame.resize((round(w * scale), round(h * scale)), Image.LANCZOS)

        buf = io.BytesIO()
        frame.save(buf, format="PNG")
        frames.append(buf.getvalue())

    return frames


def clean_json_response(text: str) -> str:
    """Strip markdown fences and trailing garbage from JSON responses."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove first line (```json) and last line (```)
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    return text.strip()


def process_item(
    client: GeminiClient,
    source: GifSource,
    item: GifItem,
    prompt: str,
    retries: int = 1
) -> dict | None:
    """Process a single GIF item and return description dict."""
    # Download GIF
    gif_data = source.download(item)
    if gif_data is None:
        return None

    # Extract frames
    try:
        frames = extract_frames(gif_data)
    except Exception as e:
        print(f"  Frame extraction error: {e}", file=sys.stderr)
        return None

    # Generate description
    for attempt in range(1 + retries):
        response = client.generate(prompt, frames)
        if response is None:
            continue

        try:
            text = clean_json_response(response)
            data = json.loads(text)
            # Add metadata
            data["id"] = item.id
            data["dataset"] = item.dataset
            data["source_path"] = item.source_path
            if item.original_url:
                data["original_url"] = item.original_url
            if item.original_description:
                data["original_description"] = item.original_description
            if item.attribution:
                data["attribution"] = item.attribution
            return data
        except json.JSONDecodeError as e:
            if attempt < retries:
                print(f"  JSON parse error (retrying): {e}", file=sys.stderr)
            else:
                print(f"  JSON parse error (giving up): {e}", file=sys.stderr)
                print(f"    Raw response: {response[:300]}", file=sys.stderr)

    return None


# =============================================================================
# Main Entry Point
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="V2 GIF description pipeline")
    parser.add_argument("--source", choices=["tgif", "r2", "local"], default="tgif",
                        help="Data source type")
    parser.add_argument("--tsv", type=Path, default=DEFAULT_TSV,
                        help="Path to TGIF TSV file (for tgif source)")
    parser.add_argument("--r2-bucket", help="R2 bucket name (for r2 source)")
    parser.add_argument("--r2-prefix", default="", help="R2 key prefix filter")
    parser.add_argument("--local-dir", type=Path, help="Local directory (for local source)")
    parser.add_argument("--limit", type=int, default=100,
                        help="Limit items to process (0=all)")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIR / "descriptions.jsonl",
                        help="Output JSONL file")
    parser.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT_FILE,
                        help="Prompt file")
    parser.add_argument("--resume", action="store_true",
                        help="Resume from checkpoint")
    parser.add_argument("--workers", type=int, default=20,
                        help="Number of concurrent workers")
    parser.add_argument("--model", default="gemini-2.0-flash-lite",
                        help="Gemini model name")
    args = parser.parse_args()

    # Ensure output directory exists
    args.output.parent.mkdir(parents=True, exist_ok=True)

    # Load prompt
    if not args.prompt.exists():
        print(f"Error: Prompt file not found: {args.prompt}", file=sys.stderr)
        sys.exit(1)
    with open(args.prompt) as f:
        prompt = f.read().strip()
    print(f"Loaded prompt from {args.prompt} ({len(prompt)} chars)")

    # Initialize source
    if args.source == "tgif":
        source = TGIFSource(args.tsv)
        print(f"Using TGIF source: {args.tsv}")
    elif args.source == "r2":
        if not args.r2_bucket:
            print("Error: --r2-bucket required for r2 source", file=sys.stderr)
            sys.exit(1)
        source = R2Source(args.r2_bucket, args.r2_prefix)
        print(f"Using R2 source: {args.r2_bucket}/{args.r2_prefix}")
    elif args.source == "local":
        if not args.local_dir:
            print("Error: --local-dir required for local source", file=sys.stderr)
            sys.exit(1)
        source = LocalSource(args.local_dir)
        print(f"Using local source: {args.local_dir}")

    # Initialize Gemini client
    client = GoogleGenAIClient(model=args.model)
    print(f"Using model: {args.model}")

    # Load processing state
    state = ProcessingState()
    state_file = args.output.with_suffix(".state.json")
    if args.resume:
        state.load(state_file)
        print(f"Resuming: {len(state.processed_ids)} already processed")

    # List items to process
    print(f"Listing items (limit={args.limit})...")
    items = list(source.list_items(args.limit))
    print(f"Found {len(items)} items")

    # Filter already processed
    to_process = [item for item in items if not state.is_processed(item.id)]
    print(f"{len(to_process)} items to process with {args.workers} workers")

    if not to_process:
        print("Nothing to do!")
        return

    # Process with thread pool
    lock = threading.Lock()
    success = 0
    failed = 0
    start = time.time()

    output_mode = "a" if args.resume else "w"
    with open(args.output, output_mode) as out:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(process_item, client, source, item, prompt): item
                for item in to_process
            }

            for future in as_completed(futures):
                item = futures[future]
                result = future.result()

                with lock:
                    if result:
                        out.write(json.dumps(result) + "\n")
                        out.flush()
                        success += 1
                        state.mark_processed(item.id)
                    else:
                        failed += 1

                    done = success + failed
                    if done % 10 == 0 or done == len(to_process):
                        elapsed = time.time() - start
                        rate = done / elapsed if elapsed > 0 else 0
                        # Save state periodically
                        if done % 100 == 0:
                            state.save()
                        msg = (f"  Progress: {done}/{len(to_process)} — "
                               f"{success} ok, {failed} failed ({rate:.1f}/sec)")
                        print(f"\r{msg}\033[K", end="", flush=True)

    # Final state save
    state.save()

    print()
    elapsed = time.time() - start
    print(f"Done! {success} described, {failed} failed in {elapsed:.1f}s")
    print(f"Output: {args.output}")
    print(f"State: {state_file}")

    # Cost estimate
    input_tokens = success * 1500
    output_tokens = success * 200  # slightly higher for richer schema
    cost = (input_tokens * 0.08 / 1_000_000) + (output_tokens * 0.30 / 1_000_000)
    print(f"Estimated cost: ${cost:.4f}")


if __name__ == "__main__":
    main()
