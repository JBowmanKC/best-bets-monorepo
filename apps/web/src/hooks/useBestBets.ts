import { useState, useEffect, useCallback } from "react";
import type { BestBetsResponse } from "@best-bets/algorithm";

interface UseBestBetsOptions {
  date?: string;
  sports?: string[];
}

interface UseBestBetsResult {
  data:      BestBetsResponse | null;
  loading:   boolean;
  error:     string | null;
  refresh:   () => void;
  lastFetch: Date | null;
}

// `options` is accepted (but unused) for compatibility with existing callers —
// picks.json is a static file that always holds today's picks, so there is no
// date/sports selection to make at fetch time.
export function useBestBets(_options: UseBestBetsOptions = {}): UseBestBetsResult {
  const [data,      setData]      = useState<BestBetsResponse | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [tick,      setTick]      = useState(0);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/picks.json?t=${Date.now()}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: BestBetsResponse) => {
        if (cancelled) return;
        setData(json);
        setLastFetch(new Date());
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tick]);

  return { data, loading, error, refresh, lastFetch };
}
