import { useEffect, useState } from "react";
import type { BankrollFile } from "@best-bets/algorithm";

interface Fetched<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * The $500 virtual bankroll ledger (see apps/web/public/bankroll.json).
 *
 * Unlike picks.json, this file is rewritten by a second workflow
 * (Resolve Results) hours after the page might already be cached, so it's
 * fetched with a cache-busting query param rather than trusted to be fresh
 * for the lifetime of the deploy.
 */
export function useBankroll(): Fetched<BankrollFile> {
  const [state, setState] = useState<Fetched<BankrollFile>>({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;

    fetch(`/bankroll.json?t=${Date.now()}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<BankrollFile>;
      })
      .then(data => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ data: null, loading: false, error: err.message });
      });

    return () => { cancelled = true; };
  }, []);

  return state;
}
