import { useState, useCallback, useEffect } from 'react';
import { SearchBox } from './components/SearchBox';
import { GifGrid } from './components/GifGrid';
import { GifDetail } from './components/GifDetail';
import { AboutModal } from './components/AboutModal';
import { searchGifs, getRandomGifs, getGifById, type GifResult } from './lib/antfly';

const TABLE_NAME = 'tgif_gifs_text';

function App() {
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [selectedGif, setSelectedGif] = useState<GifResult | null>(null);
  const [searchKey, setSearchKey] = useState(0);
  const [showAbout, setShowAbout] = useState(false);
  const [totalGifs, setTotalGifs] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  // Toggle dark mode
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  // Sync selectedGif ↔ URL ?gif= param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (selectedGif) {
      params.set('gif', selectedGif.id);
    } else {
      params.delete('gif');
    }
    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', newUrl);
  }, [selectedGif]);

  // Load GIFs on mount, then open deep-linked GIF if any
  useEffect(() => {
    const loadGifs = async () => {
      setIsLoading(true);
      setError(null);
      setGifs([]);
      setLastQuery('');
      try {
        const response = await getRandomGifs(TABLE_NAME);
        setGifs(response.results);
        setTotalGifs(response.total);

        // Check for deep-linked GIF in URL
        const params = new URLSearchParams(window.location.search);
        const gifId = params.get('gif');
        if (gifId && !selectedGif) {
          // Try to find it in loaded results first
          const found = response.results.find(g => g.id === gifId);
          if (found) {
            setSelectedGif(found);
          } else {
            // Fetch it directly from Antfly
            const gif = await getGifById(TABLE_NAME, gifId);
            if (gif) setSelectedGif(gif);
          }
        }
      } catch (err) {
        console.error('Failed to load GIFs:', err);
        setError(err instanceof Error ? err.message : 'Failed to connect to Antfly');
      } finally {
        setIsLoading(false);
        setInitialLoadDone(true);
      }
    };
    loadGifs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = useCallback(async (query: string) => {
    if (query === lastQuery) return;
    setLastQuery(query);
    setSearchInput(query);
    setIsLoading(true);
    setError(null);

    try {
      const response = await searchGifs(query, TABLE_NAME, 20);
      setGifs(response.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      console.error('Search error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [lastQuery]);

  const handleClearSearch = useCallback(async () => {
    setSearchKey(k => k + 1);
    setLastQuery('');
    setSearchInput('');
    setIsLoading(true);
    setError(null);
    try {
      const response = await getRandomGifs(TABLE_NAME, 30);
      setGifs(response.results);
      setTotalGifs(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load GIFs');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Handle tag click from GifDetail: append tag: prefix and search
  const handleTagClick = useCallback(async (tag: string) => {
    const tagExpr = tag.includes(' ') ? `tag:"${tag}"` : `tag:${tag}`;
    const newQuery = (searchInput ? searchInput + ' ' : '') + tagExpr;
    setSearchInput(newQuery);
    setSelectedGif(null); // close detail
    setSearchKey(k => k + 1); // force SearchBox remount with new value
    setLastQuery(''); // reset so handleSearch doesn't skip
    setIsLoading(true);
    setError(null);
    try {
      const response = await searchGifs(newQuery, TABLE_NAME, 20);
      setGifs(response.results);
      setLastQuery(newQuery);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setIsLoading(false);
    }
  }, [searchInput]);

  return (
    <div className="min-h-screen bg-[hsl(var(--background))]">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-[hsl(var(--background))]/95 backdrop-blur border-b border-[hsl(var(--border))]">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between mb-4">
            <h1
              className="text-2xl font-bold text-[hsl(var(--foreground))] cursor-pointer hover:opacity-80 transition-opacity"
              onClick={handleClearSearch}
              title="Clear search"
            >
              Honeycomb
            </h1>
            <button
              onClick={() => setIsDark(!isDark)}
              className="p-2 rounded-lg hover:bg-[hsl(var(--muted))] transition-colors"
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
          </div>
          <SearchBox key={searchKey} onSearch={handleSearch} isLoading={isLoading} initialValue={searchInput} />
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {error ? (
          <div className="text-center py-12">
            <p className="text-red-500 mb-2">{error}</p>
            <p className="text-[hsl(var(--muted-foreground))] text-sm">
              Make sure Antfly is running: <code className="bg-[hsl(var(--muted))] px-2 py-1 rounded">antfly swarm</code>
            </p>
          </div>
        ) : initialLoadDone && gifs.length === 0 && !lastQuery ? (
          <div className="text-center py-12">
            <h2 className="text-xl font-semibold text-[hsl(var(--foreground))] mb-4">
              No GIFs loaded yet
            </h2>
            <p className="text-[hsl(var(--muted-foreground))] mb-4">
              You need to import the TGIF dataset first:
            </p>
            <div className="bg-[hsl(var(--muted))] rounded-lg p-4 max-w-xl mx-auto text-left">
              <pre className="text-sm overflow-x-auto">
{`# 1. Make sure Antfly is running
antfly swarm

# 2. Import the dataset (from gif-picker/ingest)
cd ingest
go run main.go -tsv /path/to/TGIF-Release/data/tgif-v1.0.tsv

# For a quick test, limit to 1000 GIFs:
go run main.go -tsv /path/to/TGIF-Release/data/tgif-v1.0.tsv -limit 1000`}
              </pre>
            </div>
            <p className="text-[hsl(var(--muted-foreground))] mt-4 text-sm">
              Check the browser console for debugging info.
            </p>
          </div>
        ) : (
          <>
            {lastQuery && (
              <p className="text-[hsl(var(--muted-foreground))] mb-4">
                {gifs.length} results for "{lastQuery}"
              </p>
            )}
            <GifGrid gifs={gifs} isLoading={isLoading} onGifClick={setSelectedGif} hasActiveSearch={!!lastQuery} />
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[hsl(var(--border))] mt-12">
        <div className="max-w-7xl mx-auto px-4 py-6 text-center text-[hsl(var(--muted-foreground))] text-sm">
          <p>
            Powered by{' '}
            <a
              href="https://antfly.io"
              className="text-[hsl(var(--foreground))] hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Antfly
            </a>
            {totalGifs != null && totalGifs > 0 && (
              <> &bull; {totalGifs.toLocaleString()} GIFs</>
            )}
          </p>
          <p className="mt-1">
            <button
              onClick={() => setShowAbout(true)}
              className="text-[hsl(var(--foreground))] hover:underline"
            >
              About Honeycomb
            </button>
          </p>
        </div>
      </footer>

      {/* Detail overlay */}
      {selectedGif && (
        <GifDetail gif={selectedGif} onClose={() => setSelectedGif(null)} hasActiveSearch={!!lastQuery} onTagClick={handleTagClick} />
      )}

      {/* About modal */}
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </div>
  );
}

export default App;
