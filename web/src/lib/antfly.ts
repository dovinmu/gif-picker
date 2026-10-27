import type { GifResult, SearchResponse } from './types';

async function readResponse<T>(response: Response, failureMessage: string): Promise<T> {
  if (!response.ok) {
    let message = failureMessage;
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // A non-JSON error response still needs to surface as a failure.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function searchGifs(
  query: string,
  limit: number = 50,
  moodFilter?: string,
): Promise<SearchResponse> {
  const response = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, mood: moodFilter }),
  });
  return readResponse<SearchResponse>(response, 'Search failed');
}

export async function getRandomGifs(
  limit: number = 30,
  moodFilter?: string,
): Promise<SearchResponse> {
  const response = await fetch('/api/random', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit, mood: moodFilter }),
  });
  return readResponse<SearchResponse>(response, 'Failed to load GIFs');
}

export async function getGifById(id: string): Promise<GifResult | null> {
  const response = await fetch(`/api/gifs/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  return readResponse<GifResult>(response, 'Failed to load GIF');
}
