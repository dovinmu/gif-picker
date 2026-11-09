// Antfly API client for GIF search

// Antfly serves its data API under /db/v1. In dev, Vite proxies this path;
// in production, Caddy proxies it (to a local Antfly or to Antfly Cloud).
const API_BASE = '/db/v1';

declare const __NSFW_MODE__: boolean;

// In SFW mode (default), hide GIFs with these tags or rating:X.
// Start with NSFW=1 npm run dev to disable all content filtering.
const BLOCKED_TAGS: Set<string> = __NSFW_MODE__
  ? new Set()
  : new Set(['porn', 'sexual', 'nsfw', 'adult-content']);
const BLOCKED_RATINGS: Set<string> = __NSFW_MODE__
  ? new Set()
  : new Set(['x']);

export interface GifResult {
  id: string;
  score: number;
  gif_url: string;
  description: string;
  tumblr_id?: string;
  original_description?: string;
  literal?: string;
  mood?: string;
  mood_emoji?: string;
  action?: string | string[];
  context?: string;
  source?: string;
  tags?: string[];
  attribution?: string;
  combined_text?: string;
  rank?: number;
  [key: string]: unknown; // allow arbitrary extra fields from API
}

export interface SearchResponse {
  results: GifResult[];
  total: number;
}

// Antfly reports hits.total as {value, relation}; older servers sent a number.
// relation "gte" means value is only a lower bound.
interface HitsTotal {
  value: number;
  exact: boolean;
}

function readTotal(raw: unknown): HitsTotal | undefined {
  if (typeof raw === 'number') return { value: raw, exact: true };
  if (raw && typeof raw === 'object') {
    const { value, relation } = raw as { value?: unknown; relation?: unknown };
    if (typeof value === 'number') return { value, exact: relation !== 'gte' };
  }
  return undefined;
}

function postQuery(tableName: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${API_BASE}/tables/${tableName}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function getGifById(tableName: string, id: string): Promise<GifResult | null> {
  try {
    // `term` on `_id` matches nothing; Antfly looks up document keys with an ids query.
    const response = await postQuery(tableName, {
      full_text_search: { ids: [id] },
      limit: 1,
    });
    if (!response.ok) return null;
    const data = await response.json();
    const hit = data.responses?.[0]?.hits?.hits?.[0];
    if (!hit) return null;
    const source = hit._source ?? hit.source ?? {};
    if (isRemovedGif(source) || hasBlockedTag(source) || hasBlockedRating(source)) return null;
    return {
      ...source,
      id: hit._id ?? hit.id ?? id,
      score: 0,
      gif_url: source.gif_url ?? '',
      description: source.description ?? source.original_description ?? '',
    };
  } catch {
    return null;
  }
}

// Detect GIFs removed by Tumblr (copyright/guideline violations)
function isRemovedGif(source: Record<string, any>): boolean {
  const fields = [source.literal, source.description, source.combined_text];
  return fields.some(f => typeof f === 'string' && f.toLowerCase().includes('content has been removed'));
}

// Check if GIF has any blocked tags
function hasBlockedTag(source: Record<string, any>): boolean {
  const tags = source.tags;
  if (!Array.isArray(tags)) return false;
  return tags.some(tag => typeof tag === 'string' && BLOCKED_TAGS.has(tag.toLowerCase()));
}

// Check if GIF has a blocked rating
function hasBlockedRating(source: Record<string, any>): boolean {
  const rating = source.rating;
  if (typeof rating !== 'string') return false;
  return BLOCKED_RATINGS.has(rating.toLowerCase());
}

// Google-style query parsing: "quoted phrases", tag:X, -tag:X, and loose terms
interface ParsedQuery {
  phrases: string[];    // "quoted phrases" → match_phrase
  looseText: string;    // unquoted terms → match + semantic
  tags: string[];
  negativeTags: string[];
  ratings: string[];
}

function parseQuery(raw: string): ParsedQuery {
  const tags: string[] = [];
  const negativeTags: string[] = [];
  const ratings: string[] = [];
  const phrases: string[] = [];

  // Strip -tag:"quoted" and -tag:word first
  let remaining = raw
    .replace(/-tag:"([^"]+)"/g, (_, tag) => {
      negativeTags.push(tag.toLowerCase());
      return '';
    })
    .replace(/-tag:(\S+)/g, (_, tag) => {
      negativeTags.push(tag.toLowerCase());
      return '';
    })
    // Then tag:"quoted" and tag:word
    .replace(/tag:"([^"]+)"/g, (_, tag) => {
      tags.push(tag.toLowerCase());
      return '';
    })
    .replace(/tag:(\S+)/g, (_, tag) => {
      tags.push(tag.toLowerCase());
      return '';
    })
    // rating:"quoted" and rating:word
    .replace(/rating:"([^"]+)"/g, (_, r) => {
      ratings.push(r.toLowerCase());
      return '';
    })
    .replace(/rating:(\S+)/g, (_, r) => {
      ratings.push(r.toLowerCase());
      return '';
    });

  // Extract "quoted phrases"
  remaining = remaining.replace(/"([^"]+)"/g, (_, phrase) => {
    phrases.push(phrase.trim());
    return '';
  });

  const looseText = remaining.trim();
  return { phrases, looseText, tags, negativeTags, ratings };
}

// Build the full_text_search value from parsed query components
function buildFullTextSearch(phrases: string[], looseText: string): Record<string, unknown> | undefined {
  const parts: Record<string, unknown>[] = [];

  for (const phrase of phrases) {
    parts.push({ match_phrase: phrase, field: 'combined_text' });
  }
  if (looseText) {
    parts.push({ match: looseText, field: 'combined_text' });
  }

  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { conjuncts: parts };
}

// Clause matching a value in an analyzed field. The analyzer splits on hyphens
// and spaces (e.g. "adult-content" → ["adult","content"], "PG-13" → ["pg","13"])
// and stems ("animal" is indexed as "anim"), so values go through match /
// match_phrase rather than an unanalyzed term query. Results are post-filtered
// for exact tag/rating equality below.
function fieldValueClause(field: string, value: string): Record<string, unknown> {
  const analyzedForm = value.replace(/-/g, ' ');
  return analyzedForm.includes(' ')
    ? { match_phrase: analyzedForm, field }
    : { match: analyzedForm, field };
}

// Build exclusion_query from negative tags, blocked tags, and blocked ratings.
// Ratings are single letters ("x"), so a term query matches them exactly.
// Antfly v0.3 rejects (422) an exclusion that mixes analyzed clauses with a
// clause on a field that no document in the table has; Honeycomb tables
// always carry rating, so this only bites on tables loaded without it.
function buildExclusionQuery(negativeTags: string[]): Record<string, unknown> | undefined {
  const parts: Record<string, unknown>[] = [];

  for (const tag of [...BLOCKED_TAGS, ...negativeTags]) {
    parts.push(fieldValueClause('tags', tag));
  }
  for (const rating of BLOCKED_RATINGS) {
    parts.push({ term: rating, field: 'rating' });
  }

  if (parts.length === 0) return undefined;
  return { disjuncts: parts };
}

export async function searchGifs(
  query: string,
  tableName: string,
  limit: number = 50,
  moodFilter?: string,
): Promise<SearchResponse> {
  const body: Record<string, unknown> = { limit };
  const { phrases, looseText, tags, negativeTags, ratings } = parseQuery(query);

  const fts = buildFullTextSearch(phrases, '');
  const hasTextSearch = !!(fts || looseText);

  if (fts) {
    body.full_text_search = fts;
  }

  // Only include semantic search when there are unquoted terms
  if (looseText) {
    body.semantic_search = looseText;
    body.indexes = ['embeddings'];
    if (fts) {
      body.merge_config = { strategy: 'rrf' };
    }
  }

  // Build structured filter queries from tag: and rating: prefixes
  const filterParts: Record<string, unknown>[] = [
    ...tags.map(t => fieldValueClause('tags', t)),
    ...ratings.map(r => fieldValueClause('rating', r)),
  ];

  // Mood emoji filter
  if (moodFilter) {
    filterParts.push(fieldValueClause('mood_emoji', moodFilter));
  }

  if (filterParts.length > 0) {
    const filterQuery = filterParts.length === 1 ? filterParts[0] : { conjuncts: filterParts };

    if (hasTextSearch) {
      body.filter_query = filterQuery;
    } else {
      // Filter-only (no text/semantic search): use as primary full-text search
      body.full_text_search = filterQuery;
    }
  }

  // Apply negative tags exclusion
  const exclusion = buildExclusionQuery(negativeTags);
  if (exclusion) {
    body.exclusion_query = exclusion;
  }

  const response = await postQuery(tableName, body);

  if (!response.ok) {
    throw new Error(`Search failed: ${response.statusText}`);
  }

  const data = await response.json();

  // Debug: log raw response in development
  if (import.meta.env.DEV) {
    console.log('Antfly raw response:', JSON.stringify(data, null, 2).slice(0, 1000));
  }

  // Check for error in response
  const firstResponse = data.responses?.[0];
  if (firstResponse?.error) {
    throw new Error(firstResponse.error);
  }

  // Transform Antfly response to our format
  const hits = firstResponse?.hits?.hits ?? [];
  const results: GifResult[] = hits
    .filter((hit: any) => {
      const source = hit.source ?? hit._source ?? {};
      return !isRemovedGif(source) && !hasBlockedTag(source) && !hasBlockedRating(source);
    })
    .map((hit: any, index: number) => {
      // Debug: log first hit structure
      if (import.meta.env.DEV && index === 0) {
        console.log('First hit structure:', hit);
      }
      const source = hit.source ?? hit._source ?? {};
      return {
        ...source,
        id: hit.id ?? hit._id ?? '',
        score: hit._index_scores?.embeddings ?? hit._score ?? 0,
        gif_url: source.gif_url ?? '',
        description: source.description ?? source.original_description ?? '',
        rank: index + 1,
      };
    });

  // Post-filter for exact tag/rating matching — Bleve tokenizes on hyphens,
  // so a term query for a tag also matches compound tags containing that word.
  // The server query is best-effort; we do exact string matching here.
  const filtered = results.filter((gif) => {
    if (tags.length > 0) {
      const gifTags = (gif.tags ?? []).map((t: string) => t.toLowerCase());
      if (!tags.every(t => gifTags.includes(t))) return false;
    }
    if (ratings.length > 0) {
      const gifRating = (typeof gif.rating === 'string' ? gif.rating : '').toLowerCase();
      if (!ratings.includes(gifRating)) return false;
    }
    return true;
  });

  return {
    results: filtered,
    total: readTotal(firstResponse?.hits?.total)?.value ?? filtered.length,
  };
}

const TOTAL_CACHE_KEY = 'honeycomb_gif_total_v2';
const TOTAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function readCachedTotal(): number | undefined {
  try {
    const cached = JSON.parse(localStorage.getItem(TOTAL_CACHE_KEY) ?? 'null');
    if (typeof cached?.total === 'number' && Date.now() - cached.at < TOTAL_CACHE_TTL_MS) {
      return cached.total;
    }
  } catch {
    // Missing or unreadable cache: count again.
  }
  return undefined;
}

function writeCachedTotal(total: number): void {
  try {
    localStorage.setItem(TOTAL_CACHE_KEY, JSON.stringify({ total, at: Date.now() }));
  } catch {
    // Storage unavailable: the count is simply not cached.
  }
}

// Browse responses only report a lower-bound total, so the exact number of
// visible GIFs comes from a separate count-only query, cached per browser.
async function countGifs(tableName: string, exclusion: Record<string, unknown> | undefined): Promise<number | undefined> {
  try {
    const body: Record<string, unknown> = { count: true };
    if (exclusion) body.exclusion_query = exclusion;
    const resp = await postQuery(tableName, body);
    if (!resp.ok) return undefined;
    const data = await resp.json();
    const total = readTotal(data.responses?.[0]?.hits?.total);
    return total?.exact ? total.value : undefined;
  } catch {
    return undefined;
  }
}

// Max offset for random GIF loading — Bleve implements offset as a linear
// scan, so large values (e.g. 30k on 106k records) take ~29s and pin a CPU
// core. Capping at 2000 keeps scans under ~1s.
const MAX_RANDOM_OFFSET = 2000;

export async function getRandomGifs(tableName: string, limit: number = 30, moodFilter?: string): Promise<SearchResponse> {
  // When mood filter is active, use searchGifs with empty query to get filtered results
  if (moodFilter) {
    return searchGifs('', tableName, limit, moodFilter);
  }

  const exclusion = buildExclusionQuery([]);

  // Pick a random offset from the cached total (offset 0 when nothing is cached).
  // Without a cached total, count in parallel so the next visit can randomize.
  const cachedTotal = readCachedTotal();
  const countPromise = cachedTotal === undefined ? countGifs(tableName, exclusion) : Promise.resolve(undefined);
  const knownTotal = cachedTotal ?? 0;
  const maxOffset = Math.min(knownTotal > limit ? knownTotal - limit : 0, MAX_RANDOM_OFFSET);
  const randomOffset = maxOffset > 0 ? Math.floor(Math.random() * maxOffset) : 0;

  const browse = async (offset: number) => {
    const body: Record<string, unknown> = { limit, offset };
    if (exclusion) body.exclusion_query = exclusion;
    const resp = await postQuery(tableName, body);
    if (!resp.ok) throw new Error(`Failed to load GIFs: ${resp.statusText}`);
    const data = await resp.json();
    return data.responses?.[0]?.hits ?? {};
  };

  let page = await browse(randomOffset);
  // If a stale cached total made the offset overshoot (0 results), retry once at offset 0
  if ((page.hits ?? []).length === 0 && randomOffset > 0) {
    page = await browse(0);
  }

  const counted = await countPromise;
  if (counted !== undefined) writeCachedTotal(counted);
  const pageTotal = readTotal(page.total);
  const total = cachedTotal ?? counted ?? (pageTotal?.exact ? pageTotal.value : 0);

  return buildRandomResponse(page.hits ?? [], total, limit);
}

function buildRandomResponse(hits: any[], total: number, limit: number): SearchResponse {
  const pool: GifResult[] = hits
    .filter((hit: any) => {
      const source = hit.source ?? hit._source ?? {};
      return !isRemovedGif(source) && !hasBlockedTag(source) && !hasBlockedRating(source);
    })
    .map((hit: any) => {
      const source = hit.source ?? hit._source ?? {};
      return {
        ...source,
        id: hit.id ?? hit._id ?? '',
        score: hit._score ?? 1,
        gif_url: source.gif_url ?? '',
        description: source.description ?? source.original_description ?? '',
      };
    });

  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return {
    results: pool.slice(0, limit),
    total,
  };
}
