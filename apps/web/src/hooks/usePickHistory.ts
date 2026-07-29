import { useEffect, useState } from "react";
import type { BestBetsResponse, HistoryIndex, HistoryRun, ResultsFile } from "@best-bets/algorithm";

interface Fetched<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

/**
 * The manifest of every archived run.
 *
 * `history-index.json` is regenerated at build time from the picks/ and
 * results/ directories, so it is always in step with the files that shipped
 * with this deploy — no cache-busting query needed.
 */
export function useHistoryIndex(): Fetched<HistoryIndex> {
  const [state, setState] = useState<Fetched<HistoryIndex>>({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;

    getJson<HistoryIndex>("/history-index.json")
      .then(data => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((err: Error) => {
        if (!cancelled) setState({ data: null, loading: false, error: err.message });
      });

    return () => { cancelled = true; };
  }, []);

  return state;
}

export interface RunDetail {
  picks: BestBetsResponse;
  results: ResultsFile | null;
}

/**
 * A single run's picks (and graded results, when it has been graded).
 *
 * Fetched only when a run is expanded — the archive grows by two files a day,
 * and pulling every payload up front to render a list would be wasteful.
 * Pass `null` to fetch nothing.
 */
export function useRunDetail(run: HistoryRun | null): Fetched<RunDetail> {
  const [state, setState] = useState<Fetched<RunDetail>>({ data: null, loading: false, error: null });

  useEffect(() => {
    if (!run) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ data: null, loading: true, error: null });

    Promise.all([
      getJson<BestBetsResponse>(run.picksPath),
      run.resultsPath ? getJson<ResultsFile>(run.resultsPath) : Promise.resolve(null),
    ])
      .then(([picks, results]) => {
        if (!cancelled) setState({ data: { picks, results }, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ data: null, loading: false, error: err.message });
      });

    return () => { cancelled = true; };
  }, [run?.stamp, run?.resultsPath]);

  return state;
}
