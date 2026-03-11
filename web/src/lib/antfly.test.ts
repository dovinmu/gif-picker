import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchGifs, getRandomGifs } from './antfly';

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock localStorage (jsdom's implementation is incomplete)
const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const key in store) delete store[key]; }),
  get length() { return Object.keys(store).length; },
  key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
};
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });

const TEXT_TABLE = 'honeycomb';

describe('Antfly API Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('searchGifs', () => {
    it('should send correct request to Antfly API', async () => {
      const mockResponse = {
        responses: [
          {
            hits: {
              hits: [
                {
                  id: 'gif_123',
                  _index_scores: { embeddings: 0.95 },
                  source: {
                    gif_url: 'https://example.com/cat.gif',
                    description: 'a cat playing',
                    tumblr_id: 'abc123',
                  },
                },
              ],
              total: 1,
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await searchGifs('cat playing', TEXT_TABLE, 50);

      // Verify the request
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/tables/honeycomb/query',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      // Verify the response transformation
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('gif_123');
      expect(result.results[0].gif_url).toBe('https://example.com/cat.gif');
      expect(result.total).toBe(1);
    });

    it('should handle empty results', async () => {
      const mockResponse = {
        responses: [
          {
            hits: {
              hits: [],
              total: 0,
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await searchGifs('nonexistent query', TEXT_TABLE);

      expect(result.results).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should handle missing fields gracefully', async () => {
      const mockResponse = {
        responses: [
          {
            hits: {
              hits: [
                {
                  id: 'gif_456',
                  _score: 0.8,
                  source: {}, // Missing fields
                },
              ],
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await searchGifs('test', TEXT_TABLE);

      expect(result.results[0].id).toBe('gif_456');
      expect(result.results[0].gif_url).toBe('');
      expect(result.results[0].description).toBe('');
    });

    it('should handle _source format (Elasticsearch style)', async () => {
      const mockResponse = {
        responses: [
          {
            hits: {
              hits: [
                {
                  _id: 'gif_789',
                  _score: 0.9,
                  _source: {
                    gif_url: 'https://example.com/es.gif',
                    description: 'elasticsearch style',
                    tumblr_id: 'es123',
                  },
                },
              ],
              total: 1,
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await searchGifs('test', TEXT_TABLE);

      expect(result.results[0].id).toBe('gif_789');
      expect(result.results[0].gif_url).toBe('https://example.com/es.gif');
    });

    it('should throw error on API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
      });

      await expect(searchGifs('test', TEXT_TABLE)).rejects.toThrow('Search failed: Internal Server Error');
    });

    it('should handle malformed response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}), // Empty response
      });

      const result = await searchGifs('test', TEXT_TABLE);

      expect(result.results).toHaveLength(0);
    });
  });

  describe('getRandomGifs', () => {
    beforeEach(() => {
      mockLocalStorage.clear();
    });

    it('should fetch random GIFs using seed word match queries', async () => {
      // First call: count query (no cached total)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          responses: [{ hits: { total: 106109 } }],
        }),
      });

      // Second call: seed word match query
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          responses: [{
            hits: {
              hits: [
                { id: 'gif_1', source: { gif_url: 'https://example.com/1.gif', description: 'funny cat' } },
                { id: 'gif_2', source: { gif_url: 'https://example.com/2.gif', description: 'happy dog' } },
              ],
              total: 2,
            },
          }],
        }),
      });

      const result = await getRandomGifs('honeycomb', 30);

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify count query
      const countCall = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(countCall.limit).toBe(1);

      // Verify seed word query uses full_text_search match
      const seedCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(seedCall.full_text_search).toHaveProperty('match');
      expect(seedCall.full_text_search).toHaveProperty('field', 'combined_text');
      expect(seedCall.limit).toBe(40); // limit + 10 over-fetch

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.total).toBe(106109); // Uses cached corpus total
    });

    it('should skip count query when total is cached', async () => {
      store['honeycomb_gif_total'] = '106109';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          responses: [{
            hits: {
              hits: [
                { id: 'gif_1', source: { gif_url: 'https://example.com/1.gif', description: 'funny cat' } },
              ],
              total: 1,
            },
          }],
        }),
      });

      const result = await getRandomGifs('honeycomb', 30);

      // Only one fetch call — no count query needed
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.total).toBe(106109);
    });

    it('should retry with fallback word on empty results', async () => {
      store['honeycomb_gif_total'] = '106109';

      // First call: empty results from seed words
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          responses: [{ hits: { hits: [], total: 0 } }],
        }),
      });

      // Second call: fallback word gets results
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          responses: [{
            hits: {
              hits: [
                { id: 'gif_fb', source: { gif_url: 'https://example.com/fb.gif', description: 'fallback gif' } },
              ],
              total: 1,
            },
          }],
        }),
      });

      const result = await getRandomGifs('honeycomb', 30);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.results).toHaveLength(1);
      expect(result.total).toBe(106109);
    });
  });
});
