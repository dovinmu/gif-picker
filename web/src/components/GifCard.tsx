import { useState, useCallback } from "react";
import type { GifResult } from "../lib/antfly";

interface GifCardProps {
  gif: GifResult;
  onClick?: () => void;
  hasActiveSearch?: boolean;
}

export function GifCard({ gif, onClick, hasActiveSearch }: GifCardProps) {
  const [copied, setCopied] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(gif.gif_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [gif.gif_url]);

  const handleDownload = useCallback(async () => {
    try {
      const response = await fetch(gif.gif_url);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${gif.tumblr_id || gif.id}.gif`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download:", err);
      // Fallback: open in new tab
      window.open(gif.gif_url, "_blank");
    }
  }, [gif]);

  // Handle missing URL or error state
  if (error || !gif.gif_url) {
    return (
      <div className="aspect-square bg-[hsl(var(--muted))] rounded-lg flex items-center justify-center text-[hsl(var(--muted-foreground))] text-sm mb-4 break-inside-avoid">
        {!gif.gif_url ? "No URL" : "Failed to load"}
      </div>
    );
  }

  return (
    <div
      className="group relative rounded-lg overflow-hidden bg-[hsl(var(--card))] border border-[hsl(var(--border))] hover:border-[hsl(var(--ring))] transition-colors mb-4 break-inside-avoid cursor-pointer"
      onClick={onClick}
    >
      {/* Loading skeleton - positioned absolute so image can load underneath */}
      {!loaded && (
        <div className="absolute inset-0 bg-[hsl(var(--muted))] animate-pulse" />
      )}

      {/* GIF image - always rendered to allow lazy loading to work */}
      <img
        src={gif.gif_url}
        alt={gif.description}
        loading="lazy"
        className={`w-full h-auto transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-between p-3">
        {/* Description */}
        <p className="text-white text-sm line-clamp-3">{gif.description}</p>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); handleCopy(); }}
            className="flex-1 px-3 py-2 bg-white/20 hover:bg-white/30 rounded text-white text-sm font-medium transition-colors"
          >
            {copied ? "Copied!" : "Copy URL"}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleDownload(); }}
            className="px-3 py-2 bg-white/20 hover:bg-white/30 rounded text-white text-sm font-medium transition-colors"
            title="Download GIF"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Score badge - only during active search */}
      {hasActiveSearch && (
        <div className="absolute top-2 left-2 px-2 py-1 bg-black/70 rounded text-white text-xs font-mono">
          {gif.score.toFixed(3)}
        </div>
      )}
    </div>
  );
}
