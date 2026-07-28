#!/usr/bin/env node
// One-off backfill: recovers every past version of `apps/web/public/picks.json`
// from git history into the `picks/picks-<stamp>.json` archive.
//
//   node scripts/backfill-picks-archive.mjs [--dry-run]
//
// Before the archive existed each worker run overwrote picks.json, so the only
// record of older slates is the commit history. Kept in the repo because it is
// also the recovery path if the archive directory is ever lost.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { PICKS_DIR, REPO_ROOT, toStamp } from "./lib/history.mjs";

const run = promisify(execFile);
const TRACKED_PATH = "apps/web/public/picks.json";

async function git(args) {
  const { stdout } = await run("git", args, {
    cwd: REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const log = await git(["log", "--format=%H %aI", "--", TRACKED_PATH]);
  const commits = log.trim().split("\n").filter(Boolean).map(line => {
    const [sha, authored] = line.split(" ");
    return { sha, authored };
  });

  console.log(`Found ${commits.length} commit(s) touching ${TRACKED_PATH}.`);
  let written = 0, skipped = 0;

  for (const { sha, authored } of commits) {
    let payload;
    try {
      payload = JSON.parse(await git(["show", `${sha}:${TRACKED_PATH}`]));
    } catch (err) {
      console.warn(`  ! ${sha.slice(0, 8)}: could not read picks.json (${err.message})`);
      continue;
    }

    // The payload's own generatedAt is when the picks were computed; the commit
    // timestamp is a few seconds later. Prefer the former, fall back to the commit.
    const generatedAt = Date.parse(payload.generatedAt) ? new Date(payload.generatedAt) : new Date(authored);
    const stamp = toStamp(generatedAt);
    const dest = join(PICKS_DIR, `picks-${stamp}.json`);

    if (existsSync(dest)) {
      skipped += 1;
      continue;
    }

    console.log(`  ${stamp} ← ${sha.slice(0, 8)} (${payload.date}, ${payload.picks?.length ?? 0} picks)`);
    if (dryRun) continue;

    await mkdir(PICKS_DIR, { recursive: true });
    await writeFile(dest, `${JSON.stringify(payload)}\n`, "utf8");
    written += 1;
  }

  console.log(`Wrote ${written} archive file(s), skipped ${skipped} already present.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
