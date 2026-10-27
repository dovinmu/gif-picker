import type { Config } from './config.ts';
import type { GifResult, SearchResponse } from '../src/lib/types.ts';

export class UpstreamError extends Error {
  constructor() { super('Antfly request failed'); }
}
type RecordData = Record<string, unknown>;
function object(value: unknown): value is RecordData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
interface Hit {
  hit: RecordData;
  source: RecordData;
  id: string;
}
export async function boundedJson(response: Response, max: number): Promise<unknown> {
  if (!response.body) throw new UpstreamError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new UpstreamError();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => {}); }
}

// Google-style phrases, structured tags/ratings, and semantic loose text.
function parseQuery(raw: string) {
  const tags: string[] = [], negativeTags: string[] = [], ratings: string[] = [], phrases: string[] = [];
  let remaining = raw.replace(/(-?tag|rating):(?:"((?:\\.|[^"\\])+)"|(\S+))/g, (_, kind: string, quoted: string | undefined, bare: string | undefined) => {
    const value = (quoted === undefined ? bare! : quoted.replace(/\\(["\\])/g, '$1')).toLowerCase();
    (kind === '-tag' ? negativeTags : kind === 'tag' ? tags : ratings).push(value);
    return '';
  });
  remaining = remaining.replace(/"([^"\n]+)"/g, (_, phrase: string) => { phrases.push(phrase.trim()); return ''; });
  return { tags, negativeTags, ratings, phrases, looseText: remaining.trim() };
}
export function createAntfly(config: Config) {
  const blockedTags: string[] = config.nsfw ? [] : ['porn', 'sexual', 'nsfw', 'adult-content'];
  const blockedRatings: string[] = config.nsfw ? [] : ['x'];
  const url = `${config.antflyUrl}/tables/${encodeURIComponent(config.table)}/query`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.authorization) headers.Authorization = config.authorization;
  let cachedTotal = 0;
  function permitted(source: RecordData) {
    return ![source.literal, source.description, source.combined_text].some(v => typeof v === 'string' && v.toLowerCase().includes('content has been removed'))
      && !(Array.isArray(source.tags) && source.tags.some(t => typeof t === 'string' && blockedTags.includes(t.toLowerCase())))
      && !(typeof source.rating === 'string' && blockedRatings.includes(source.rating.toLowerCase()));
  }
  function exclusion(negativeTags: string[]) {
    const parts = [...blockedTags, ...negativeTags].map(t => `tags:"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    parts.push(...blockedRatings.map(r => `rating:"${r}"`));
    return parts.length ? { query: parts.join(' OR ') } : undefined;
  }
  async function query(body: RecordData, signal: AbortSignal) {
    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'manual' });
      if (!response.ok) { await response.body?.cancel(); throw new UpstreamError(); }
      const data = await boundedJson(response, 4 * 1024 * 1024);
      if (!object(data) || data.error || !Array.isArray(data.responses) || data.responses.length !== 1) throw new UpstreamError();
      const first = data.responses[0];
      if (!object(first) || first.error || !object(first.hits) || !Array.isArray(first.hits.hits)
        || typeof first.hits.total !== 'number' || !Number.isFinite(first.hits.total) || first.hits.total < 0) throw new UpstreamError();
      const hits = first.hits.hits.map((hit: unknown) => {
        if (!object(hit)) throw new UpstreamError();
        const source = hit.source ?? hit._source;
        const id = hit.id ?? hit._id;
        if (!object(source) || typeof id !== 'string' || !id || (source.tags !== undefined && (!Array.isArray(source.tags) || source.tags.some(t => typeof t !== 'string')))) throw new UpstreamError();
        for (const key of ['gif_url', 'description', 'original_description']) {
          if (source[key] !== undefined && typeof source[key] !== 'string') throw new UpstreamError();
        }
        return { hit, source, id };
      });
      return { hits, total: first.hits.total };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError();
    }
  }
  function normalize({ hit, source, id }: Hit, mode: 'search' | 'random' | 'detail', rank: number): GifResult {
    const indexScores = object(hit._index_scores) ? hit._index_scores : {};
    const score = mode === 'detail' ? 0 : mode === 'search' ? indexScores.embeddings ?? hit._score ?? 0 : hit._score ?? 1;
    if (typeof score !== 'number' || !Number.isFinite(score)) throw new UpstreamError();
    return { ...source, id, score, gif_url: (source.gif_url ?? '') as string,
      description: (source.description ?? source.original_description ?? '') as string,
      ...(mode === 'search' ? { rank } : {}),
    };
  }
  async function searchGifs(raw: string, limit: number, mood: string | undefined, signal: AbortSignal): Promise<SearchResponse> {
    const { tags, negativeTags, ratings, phrases, looseText } = parseQuery(raw);
    const body: RecordData = { limit };
    const parts = phrases.map(phrase => ({ match_phrase: phrase, field: 'combined_text' }));
    if (parts.length) body.full_text_search = parts.length === 1 ? parts[0] : { conjuncts: parts };
    if (looseText) {
      body.semantic_search = looseText; body.indexes = ['embeddings'];
      if (parts.length) body.merge_strategy = 'rrf';
    }
    const filters: RecordData[] = [];
    for (const [values, field] of [[tags, 'tags'], [ratings, 'rating']] as const) {
      for (const value of values) {
        const text = value.replace(/-/g, ' ');
        filters.push(text.includes(' ') ? { match_phrase: text, field } : { term: text, field });
      }
    }
    if (mood) filters.push({ term: mood, field: 'mood_emoji' });
    if (filters.length) body[parts.length || looseText ? 'filter_query' : 'full_text_search'] = filters.length === 1 ? filters[0] : { conjuncts: filters };
    const excluded = exclusion(negativeTags);
    if (excluded) body.exclusion_query = excluded;
    const data = await query(body, signal);
    const results = data.hits.filter(h => permitted(h.source)).map((h, i) => normalize(h, 'search', i + 1)).filter(gif => {
      const actualTags = (gif.tags ?? []).map(t => t.toLowerCase());
      return tags.every(t => actualTags.includes(t)) && !negativeTags.some(t => actualTags.includes(t))
        && (!ratings.length || ratings.includes(typeof gif.rating === 'string' ? gif.rating.toLowerCase() : ''));
    });
    return { results, total: data.total };
  }
  async function getRandomGifs(limit: number, mood: string | undefined, signal: AbortSignal): Promise<SearchResponse> {
    if (mood) return searchGifs('', limit, mood, signal);
    const maxOffset = Math.min(Math.max(cachedTotal - limit, 0), 2000);
    const offset = maxOffset > 0 ? Math.floor(Math.random() * maxOffset) : 0;
    const body: RecordData = { limit, offset };
    const excluded = exclusion([]);
    if (excluded) body.exclusion_query = excluded;
    let data = await query(body, signal);
    cachedTotal = data.total;
    if (!data.hits.length && offset > 0) {
      data = await query({ ...body, offset: 0 }, signal);
      cachedTotal = data.total;
    }
    const pool = data.hits.filter(h => permitted(h.source)).map(h => normalize(h, 'random', 0));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return { results: pool.slice(0, limit), total: data.total };
  }
  async function getGifById(id: string, signal: AbortSignal): Promise<GifResult | null> {
    const data = await query({ full_text_search: { term: id, field: '_id' }, limit: 1 }, signal);
    const hit = data.hits.find(h => h.id === id && permitted(h.source));
    return hit ? normalize(hit, 'detail', 0) : null;
  }
  return { searchGifs, getRandomGifs, getGifById };
}
