import { useState, useEffect, useRef } from "react";
import { getAttributions, type AttributionBucket } from "../lib/antfly";

interface FilterOverlayProps {
  tableName: string;
  excludedAttributions: Set<string>;
  onFilterChange: (excluded: Set<string>) => void;
}

export function FilterOverlay({
  tableName,
  excludedAttributions,
  onFilterChange,
}: FilterOverlayProps) {
  const [attributions, setAttributions] = useState<AttributionBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch attributions on mount
  useEffect(() => {
    getAttributions(tableName).then((buckets) => {
      setAttributions(buckets);
      setLoading(false);
    });
  }, [tableName]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = (key: string) => {
    const next = new Set(excludedAttributions);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    onFilterChange(next);
  };

  const activeFilterCount = excludedAttributions.size;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-2 rounded-lg hover:bg-[hsl(var(--muted))] transition-colors relative"
        title="Filters"
      >
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
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        {activeFilterCount > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center font-bold">
            {activeFilterCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-64 bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-[hsl(var(--border))]">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">
              Filters
            </h3>
          </div>

          <div className="p-3 space-y-3">
            {/* Attribution section */}
            <div>
              <h4 className="text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-2">
                Source
              </h4>
              {loading ? (
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  Loading...
                </p>
              ) : attributions.length === 0 ? (
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  No sources found
                </p>
              ) : (
                <div className="space-y-1.5">
                  {attributions.map(({ key, count }) => {
                    const excluded = excludedAttributions.has(key);
                    return (
                      <label
                        key={key}
                        className="flex items-center gap-2 cursor-pointer group"
                      >
                        <input
                          type="checkbox"
                          checked={!excluded}
                          onChange={() => toggle(key)}
                          className="rounded border-[hsl(var(--border))] accent-[hsl(var(--ring))]"
                        />
                        <span
                          className={`text-sm flex-1 truncate ${
                            excluded
                              ? "text-[hsl(var(--muted-foreground))] line-through"
                              : "text-[hsl(var(--foreground))]"
                          }`}
                          title={key}
                        >
                          {key}
                        </span>
                        <span className="text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
                          {count.toLocaleString()}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Clear filters */}
          {activeFilterCount > 0 && (
            <div className="px-3 py-2 border-t border-[hsl(var(--border))]">
              <button
                onClick={() => onFilterChange(new Set())}
                className="text-xs text-[hsl(var(--ring))] hover:underline"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
