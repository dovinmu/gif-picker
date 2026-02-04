import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchGifs, getRandomGifs, type GifResult } from './antfly';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

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
                  score: 0.95,
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

      const result = await searchGifs('cat playing', 50, 0);

      // Verify the request
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/tables/tgif_gifs/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          semantic_search: 'cat playing',
          indexes: ['embeddings'],
          limit: 50,
          offset: 0,
        }),
      });

      // Verify the response transformation
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        id: 'gif_123',
        score: 0.95,
        gif_url: 'https://example.com/cat.gif',
        description: 'a cat playing',
        tumblr_id: 'abc123',
      });
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

      const result = await searchGifs('nonexistent query');

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
                  score: 0.8,
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

      const result = await searchGifs('test');

      expect(result.results[0]).toEqual({
        id: 'gif_456',
        score: 0.8,
        gif_url: '',
        description: '',
        tumblr_id: '',
      });
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

      const result = await searchGifs('test');

      expect(result.results[0]).toEqual({
        id: 'gif_789',
        score: 0.9,
        gif_url: 'https://example.com/es.gif',
        description: 'elasticsearch style',
        tumblr_id: 'es123',
      });
    });

    it('should throw error on API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
      });

      await expect(searchGifs('test')).rejects.toThrow('Search failed: Internal Server Error');
    });

    it('should handle malformed response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}), // Empty response
      });

      const result = await searchGifs('test');

      expect(result.results).toHaveLength(0);
    });

    it('should use custom limit and offset', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ responses: [{ hits: { hits: [] } }] }),
      });

      await searchGifs('test', 100, 50);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/tables/tgif_gifs/query',
        expect.objectContaining({
          body: JSON.stringify({
            semantic_search: 'test',
            indexes: ['embeddings'],
            limit: 100,
            offset: 50,
          }),
        })
      );
    });
  });

  describe('getRandomGifs', () => {
    it('should call searchGifs with a broad query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            responses: [{ hits: { hits: [], total: 0 } }],
          }),
      });

      await getRandomGifs(50);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/tables/tgif_gifs/query',
        expect.objectContaining({
          body: expect.stringContaining('person animal action'),
        })
      );
    });
  });
});
