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

export function useBestBets({ date, sports }: UseBestBetsOptions = {}): UseBestBetsResult {
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

    const params = new URLSearchParams();
    if (date)   params.set("date",   date);
    if (sports) params.set("sports", sports.join(","));

    fetch(`/api/best-bets?${params}`)
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
  }, [date, sports?.join(","), tick]);

  return { data, loading, error, refresh, lastFetch };
}
