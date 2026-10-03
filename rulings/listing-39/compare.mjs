#!/usr/bin/env node
// compare — each submission's STATED arm counts against the reference table,
// recomputed at that submission's own window, boundary and walk instant.
//
// Boundary handling: a derived boundary is a GAP, and submissions name it by
// either edge ("<= 1203 ms" or "< 18.4 s"). Any stated value that lands inside
// the gap at that cohort is the same split, so it is snapped to the lower edge.
// A value outside the gap is used as stated (delay <= value is door) and the
// row is marked boundary_not_gap, since that is a typed threshold, not a
// derived one, and requirement 2 asked for derived.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { load, score, derivedBoundary } from "./reference-score.mjs";

const [table, extractDir, listingFile, out] = process.argv.slice(2);
const T = load(table), L = JSON.parse(readFileSync(listingFile, "utf8"));
const subAt = new Map(L.submissions.map((s) => [s.id, s.created_at]));
const recs = readdirSync(extractDir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(`${extractDir}/${f}`, "utf8")));
const DEFAULT_START = Date.parse("2026-08-12T21:33:32Z");
// Submissions state instants in prose ("computed 2026-09-15T02:19:49Z (from
// cache)"). Take the FIRST full ISO instant in the string; a bare date is not an
// instant and is left unparsed rather than guessed at midnight. My parser
// failing on prose is a defect of this tool, never of the submission.
const p = (x) => { if (x == null) return null; const m = String(x).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/); if (!m) return null; const v = Date.parse(m[0].endsWith("Z") ? m[0] : m[0] + "Z"); return Number.isNaN(v) ? null : v; };

const results = [];
for (const r of recs.sort((a, b) => a.id - b.id)) {
  const c = r.claimed ?? {};
  const res = { id: r.id, handle: r.handle };
  if (!c.cutoff || !c.door?.n) { res.status = "no-numbers"; results.push(res); continue; }
  const start = p(c.start) ?? DEFAULT_START, cutoff = p(c.cutoff);
  const sa = p(c.asof); const asof = Math.min(Number.isFinite(sa) ? sa : Infinity, subAt.get(r.id));
  if (Number.isNaN(start) || Number.isNaN(cutoff)) { res.status = "unparseable-window"; results.push(res); continue; }
  const gap = derivedBoundary(T.rows, { start, cutoff, asof });
  let b = c.boundary_ms, gapNote = "derived";
  if (b == null) b = gap.below;
  else if (b >= gap.below && b <= gap.above) b = gap.below;
  else gapNote = "boundary_not_gap";
  const tries = [];
  // The listing window first; then the off-by-one windows submissions actually
  // used, so "reproduces under its own (wrong) window" is told apart from "the
  // data does not match". Only the first is requirement 3.
  const WINDOWS = [["[7d,14d)", 7, 14, false, false], ["(7d,14d]", 7, 14, true, false], ["[7d,14d]", 7, 14, false, true],
    ["[8d,15d)", 8, 15, false, false], ["[8d,14d)", 8, 14, false, false], ["[8d,14d]", 8, 14, false, true]];
  for (const [label, loDay, hiDay, closedEnd, closedBoth] of WINDOWS) for (const cutoffInclusive of [false, true])
    tries.push({ label, cutoffInclusive, closedEnd, arms: score(T.rows, { start, cutoff, boundary_ms: b, asof, cutoffInclusive, closedEnd, loDay, hiDay, closedBoth }) });
  // A record that states a rate but no count still states the count, to within
  // rounding: k = round(rate * n). Comparing n alone would let a wrong outcome
  // window pass as exact (728 did, on the first run of this tool).
  const kOf = (arm) => {
    if (arm?.k != null) return arm.k;
    if (arm?.rate == null || !arm?.n) return null;
    let r = parseFloat(String(arm.rate)); if (String(arm.rate).includes("%") || r > 1) r /= 100;
    return Number.isFinite(r) ? Math.round(r * arm.n) : null;
  };
  const cmp = (arms) => ["door", "sought", "none"].map((a) => [a, c[a]?.n ?? null, arms[a].n, kOf(c[a]), arms[a].k]);
  const exact = (arms) => cmp(arms).every(([, sn, rn, sk, rk]) => sn === rn && (sk == null || sk === rk));
  const hit = tries.find((t) => exact(t.arms));
  Object.assign(res, {
    window: [new Date(start).toISOString(), new Date(cutoff).toISOString()], asof: new Date(asof).toISOString(),
    gap: [gap.below, gap.above, +gap.ratio.toFixed(2)], stated_boundary: c.boundary_ms, boundary_note: gapNote,
    status: !hit ? (cmp(tries[0].arms).every(([, sn, rn]) => sn === rn) ? "n-matches-k-differs" : "differs") : hit.label.startsWith("[7d,14d") || hit.label === "(7d,14d]" ? "exact" : "exact-under-other-window",
    window_used: hit?.label ?? null, cutoff_inclusive: hit?.cutoffInclusive ?? null,
    table: cmp((hit ?? tries[0]).arms).map(([a, sn, rn, sk, rk]) => `${a} n ${sn}/${rn} k ${sk}/${rk}`).join("; "),
  });
  results.push(res);
}
writeFileSync(out, JSON.stringify(results, null, 1));
const tally = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
console.log(tally);
for (const r of results) if (r.status !== "exact") console.log(r.id, r.handle, r.status, r.table ?? "", r.boundary_note ?? "");
