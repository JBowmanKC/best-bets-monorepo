#!/usr/bin/env node
// Writes `apps/web/public/history-index.json` from whatever picks/results
// files are present.
//
// Static hosting can't list a directory, so this manifest is the only way the
// browser can discover archived runs. It is generated at build time (and by
// `npm run dev`) rather than committed, which keeps two GitHub Actions
// workflows from fighting over the same file.

import { mkdir, writeFile } from "node:fs/promises";

import {
  INDEX_FILE, PUBLIC_DIR, TIERS,
  emptySummary, listPicksFiles, listResultsFiles,
  mergeSummaries, readJson, summarize,
} from "./lib/history.mjs";

function tierCounts(picks) {
  const counts = Object.fromEntries(TIERS.map(t => [t, 0]));
  for (const p of picks) {
    if (counts[p.tier] !== undefined) counts[p.tier] += 1;
  }
  return counts;
}

async function main() {
  const [picksFiles, resultsFiles] = await Promise.all([listPicksFiles(), listResultsFiles()]);
  const resultsByStamp = new Map(resultsFiles.map(f => [f.stamp, f]));

  const runs = [];
  const allResults = [];

  for (const file of picksFiles) {
    let payload;
    try {
      payload = await readJson(file.path);
    } catch (err) {
      console.warn(`Skipping unreadable ${file.name}: ${err.message}`);
      continue;
    }

    const picks = payload.picks ?? [];
    const resultsFile = resultsByStamp.get(file.stamp);
    let summary = null;

    if (resultsFile) {
      try {
        const graded = await readJson(resultsFile.path);
        summary = graded.summary ?? summarize(graded.results ?? []);
        allResults.push(...(graded.results ?? []));
      } catch (err) {
        console.warn(`Skipping unreadable ${resultsFile.name}: ${err.message}`);
      }
    }

    runs.push({
      stamp:       file.stamp,
      date:        payload.date ?? "",
      generatedAt: payload.generatedAt ?? "",
      picksPath:   `/picks/${file.name}`,
      resultsPath: summary ? `/results/${resultsFile.name}` : null,
      pickCount:   picks.length,
      tierCounts:  tierCounts(picks),
      summary,
    });
  }

  runs.reverse(); // newest first — the order the history page renders in

  const index = {
    generatedAt: new Date().toISOString(),
    runs,
    totals: mergeSummaries(runs.map(r => r.summary).filter(Boolean)),
    byTier: Object.fromEntries(
      TIERS.map(tier => [tier, summarize(allResults.filter(r => r.tier === tier))])
    ),
  };

  // Keep every tier present even with no history yet, so the UI can render a
  // stable table instead of branching on missing keys.
  for (const tier of TIERS) index.byTier[tier] ??= emptySummary();

  await mkdir(PUBLIC_DIR, { recursive: true });
  await writeFile(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const t = index.totals;
  console.log(
    `history-index.json: ${runs.length} run(s), ${t.wins}W-${t.losses}L-${t.pushes}P`
    + `, ${t.unitsNet >= 0 ? "+" : ""}${t.unitsNet}u`
    + `${t.roi === null ? "" : ` (ROI ${(t.roi * 100).toFixed(1)}%)`}`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
