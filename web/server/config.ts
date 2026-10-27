export interface Config {
  port: number;
  antflyUrl: string;
  table: string;
  authorization: string;
  nsfw: boolean;
  maxConcurrentQueries: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  function integer(field: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
    const value = env[field];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
      throw new Error(`${field} must be a positive integer${field === 'PORT' ? ' in 1..65535' : ''}`);
    }
    return Number(value);
  }
  let url: URL;
  try { url = new URL(env.ANTFLY_URL ?? 'http://localhost:8080/api/v1'); }
  catch { throw new Error('ANTFLY_URL must be an HTTP(S) API base URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (!loopback && url.protocol !== 'https:')) {
    throw new Error('ANTFLY_URL requires HTTPS outside loopback and must not contain credentials, query or fragment');
  }
  const authorization = env.ANTFLY_AUTHORIZATION ?? '';
  if (/[\r\n]/.test(authorization)) throw new Error('ANTFLY_AUTHORIZATION must not contain CR/LF');
  if (!loopback && !authorization.trim()) throw new Error('ANTFLY_AUTHORIZATION is required for remote endpoints');
  const table = env.ANTFLY_TABLE ?? 'honeycomb';
  if (!table.trim()) throw new Error('ANTFLY_TABLE must be nonempty');
  return {
    port: integer('PORT', 8090, 65535), antflyUrl: url.href.replace(/\/+$/, ''), table,
    authorization, nsfw: env.NSFW === '1', maxConcurrentQueries: integer('MAX_CONCURRENT_QUERIES', 16),
  };
}
