// Run with `npm test` (Node's built-in runner — no test dependency).
//
// The score feeds can't be hit from CI-less environments, so these cover the
// pure grading logic against the feed shapes `api/best-bets.ts` already relies
// on in production.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { candidateDates, gradePick } from "./grade-picks.mjs";
import { mergeSummaries, summarize, toStamp, fromStamp, unitProfit } from "./lib/history.mjs";

const hoursAgo = h => new Date(Date.now() - h * 3_600_000).toISOString();

function pick(overrides = {}) {
  return {
    id: "823193-away",
    sport: "mlb",
    matchup: "Milwaukee Brewers @ San Francisco Giants",
    pickLabel: "Milwaukee Brewers ML",
    tier: "value",
    odds: -153,
    startTime: hoursAgo(12),
    ...overrides,
  };
}

function finalGame(homeScore, awayScore, overrides = {}) {
  return {
    homeTeam: "San Francisco Giants",
    awayTeam: "Milwaukee Brewers",
    homeScore,
    awayScore,
    state: "final",
    detail: "Final",
    ...overrides,
  };
}

describe("gradePick", () => {
  it("scores an away pick that won", () => {
    const r = gradePick(pick(), finalGame(2, 6));
    assert.equal(r.outcome, "win");
    assert.equal(r.unitsRisked, 1);
    assert.equal(r.unitsNet, 0.6536); // 100/153
    assert.deepEqual(r.finalScore, {
      homeTeam: "San Francisco Giants",
      awayTeam: "Milwaukee Brewers",
      homeScore: 2,
      awayScore: 6,
    });
  });

  it("scores an away pick that lost", () => {
    const r = gradePick(pick(), finalGame(7, 1));
    assert.equal(r.outcome, "loss");
    assert.equal(r.unitsNet, -1);
  });

  it("reads the home side for a -home pick id", () => {
    const r = gradePick(pick({ id: "823193-home", odds: 140 }), finalGame(7, 1));
    assert.equal(r.outcome, "win");
    assert.equal(r.unitsNet, 1.4);
  });

  it("treats a tie as a push with the stake returned", () => {
    const r = gradePick(pick({ sport: "nhl", id: "401-home" }), finalGame(3, 3));
    assert.equal(r.outcome, "push");
    assert.equal(r.unitsNet, 0);
  });

  it("treats a postponed game as no action", () => {
    const r = gradePick(pick(), finalGame(0, 0, { state: "no-action", detail: "Postponed" }));
    assert.equal(r.outcome, "push");
    assert.equal(r.unitsNet, 0);
    assert.match(r.note, /Postponed/);
  });

  it("leaves a game that hasn't finished pending, risking nothing", () => {
    const r = gradePick(pick({ startTime: hoursAgo(1) }), finalGame(2, 1, { state: "live", detail: "Top 5th" }));
    assert.equal(r.outcome, "pending");
    assert.equal(r.unitsRisked, 0);
    assert.equal(r.unitsNet, 0);
  });

  it("keeps a long-running game pending rather than calling it unknown", () => {
    const r = gradePick(pick({ startTime: hoursAgo(20) }), finalGame(2, 1, { state: "live", detail: "18th inning" }));
    assert.equal(r.outcome, "pending");
  });

  it("marks a missing recent game pending and a missing old game unknown", () => {
    assert.equal(gradePick(pick({ startTime: hoursAgo(2) }), undefined).outcome, "pending");
    assert.equal(gradePick(pick({ startTime: hoursAgo(48) }), undefined).outcome, "unknown");
  });

  it("does not grade a final with a missing score", () => {
    const r = gradePick(pick({ startTime: hoursAgo(48) }), finalGame(null, null));
    assert.equal(r.outcome, "unknown");
    assert.equal(r.unitsRisked, 0);
  });
});

describe("candidateDates", () => {
  it("covers the slate date plus each start date and its predecessor", () => {
    const dates = candidateDates("2026-07-28", [
      { startTime: "2026-07-28T22:40:00Z" },
      { startTime: "2026-07-29T02:10:00Z" }, // late game — MLB files it under the 28th
    ]);
    assert.deepEqual(dates, ["2026-07-27", "2026-07-28", "2026-07-29"]);
  });

  it("ignores unparseable start times", () => {
    assert.deepEqual(candidateDates("2026-07-28", [{ startTime: "nonsense" }]), ["2026-07-28"]);
  });
});

describe("summarize", () => {
  const results = [
    { outcome: "win",     unitsRisked: 1, unitsNet: 0.65, tier: "elite" },
    { outcome: "loss",    unitsRisked: 1, unitsNet: -1,   tier: "value" },
    { outcome: "push",    unitsRisked: 1, unitsNet: 0,    tier: "value" },
    { outcome: "pending", unitsRisked: 0, unitsNet: 0,    tier: "value" },
    { outcome: "unknown", unitsRisked: 0, unitsNet: 0,    tier: "value" },
  ];

  it("counts every outcome and excludes undecided picks from risk", () => {
    const s = summarize(results);
    assert.equal(s.total, 5);
    assert.equal(s.graded, 3);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 1);
    assert.equal(s.pushes, 1);
    assert.equal(s.pending, 1);
    assert.equal(s.unknown, 1);
    assert.equal(s.winRate, 0.5);
    assert.equal(s.unitsRisked, 3);
    assert.equal(s.unitsNet, -0.35);
    assert.equal(s.roi, -0.1167);
  });

  it("reports no win rate or ROI before anything is decided", () => {
    const s = summarize([{ outcome: "pending", unitsRisked: 0, unitsNet: 0 }]);
    assert.equal(s.winRate, null);
    assert.equal(s.roi, null);
  });

  it("merges per-run summaries into the same totals as grading in bulk", () => {
    const merged = mergeSummaries([summarize(results.slice(0, 2)), summarize(results.slice(2))]);
    assert.deepEqual(merged, summarize(results));
  });
});

describe("stamps", () => {
  it("round-trips a timestamp through the filename form", () => {
    const iso = "2026-07-28T19:20:19.251Z";
    const stamp = toStamp(new Date(iso));
    assert.equal(stamp, "20260728T192019Z");
    assert.equal(fromStamp(stamp).toISOString(), "2026-07-28T19:20:19.000Z");
  });

  it("sorts lexicographically in chronological order", () => {
    const stamps = ["20260728T192019Z", "20260724T152617Z", "20260728T142722Z"];
    assert.deepEqual([...stamps].sort(), ["20260724T152617Z", "20260728T142722Z", "20260728T192019Z"]);
  });

  it("rejects a malformed stamp", () => {
    assert.equal(fromStamp("not-a-stamp"), null);
  });
});

describe("unitProfit", () => {
  it("pays out underdog and favourite prices correctly", () => {
    assert.equal(unitProfit(150), 1.5);
    assert.equal(unitProfit(-200), 0.5);
    assert.equal(unitProfit(100), 1);
  });
});
