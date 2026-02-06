import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchGifs, getRandomGifs } from './antfly';

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const TEXT_TABLE = 'tgif_gifs_text';

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
        '/api/v1/tables/tgif_gifs_text/query',
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
    it('should fetch random GIFs with multiple batch requests', async () => {
      // First call: count query
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          responses: [{ hits: { total: 100 } }],
        }),
      });

      // Subsequent calls: batch fetches (up to 5 batches)
      for (let i = 0; i < 5; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            responses: [{
              hits: {
                hits: [
                  { _id: `gif_${i}`, source: { gif_url: `https://example.com/${i}.gif`, description: `gif ${i}` } },
                ],
              },
            }],
          }),
        });
      }

      const result = await getRandomGifs('tgif_gifs_text', 30);

      // Should have called fetch multiple times (1 count + up to 5 batches)
      expect(mockFetch).toHaveBeenCalled();
      expect(result.total).toBe(100);
    });
  });
});
