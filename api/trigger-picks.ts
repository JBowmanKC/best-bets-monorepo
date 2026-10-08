// Fires the Daily Picks GitHub workflow from Vercel's cron instead of
// GitHub's own `schedule:` trigger. GitHub's scheduler throttles this repo —
// it fires one to three runs a day instead of the 14 requested, always
// 3.5-5.5 hours late — so picks routinely weren't ready by kickoff. Vercel
// Cron calls this endpoint at a fixed time (see vercel.json), and this
// dispatches the workflow with respect_guard so repeat calls the same day
// are no-ops (the workflow, not this endpoint, owns the dedupe).
//
// Environment variables:
//   CRON_SECRET  — Vercel sends it as `Authorization: Bearer <secret>` on cron
//                  invocations; required so the public can't trigger runs.
//   GITHUB_TOKEN — fine-grained PAT, this repo only, "Actions: read and write".
//   GITHUB_REPO  — optional, defaults to JBowmanKC/best-bets-monorepo.

interface ApiRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  setHeader(name: string, value: string): ApiResponse;
  status(code: number): ApiResponse;
  json(body: unknown): void;
  end(): void;
}

module.exports = async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader("Cache-Control", "no-store");

  const secret = process.env.CRON_SECRET;
  const token = process.env.GITHUB_TOKEN;
  if (!secret || !token) {
    res.status(500).json({ error: "CRON_SECRET and GITHUB_TOKEN must both be configured." });
    return;
  }

  const auth = req.headers?.authorization;
  const provided = Array.isArray(auth) ? auth[0] : auth;
  if (provided !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const repo = process.env.GITHUB_REPO || "JBowmanKC/best-bets-monorepo";
  try {
    const ghRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/daily-picks.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { respect_guard: "true" } }),
      signal: AbortSignal.timeout(10_000),
    });

    if (ghRes.status !== 204) {
      res.status(502).json({ error: `GitHub dispatch failed: HTTP ${ghRes.status}`, detail: await ghRes.text() });
      return;
    }
    res.status(200).json({ dispatched: true, at: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: "GitHub dispatch threw", detail: String(e) });
  }
};
