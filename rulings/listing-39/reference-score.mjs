#!/usr/bin/env node
// reference-score — recompute a listing-39 result from the reference table at
// the submission's OWN parameters, so the comparison is like for like.
//
// A submission is reproduced at:
//   start, cutoff   its stated population window (start inclusive; cutoff
//                   exclusive by default, --cutoff-inclusive if it said so)
//   boundary_ms     its stated door/sought boundary (delay <= boundary is door)
//   asof            the instant it walked. A citizen who bound AFTER that walk
//                   was in "none" for them and is in "sought" for a later
//                   walker, so binds are filtered to before asof. Without this
//                   every honest early walk would "fail" to reproduce.
//
// The outcome is the listing's: at least one post or comment in days 8-14
// after the citizen's own registration instant, i.e. [reg+7d, reg+14d).
// The half-open edges are reported both ways so an edge convention can never
// be mistaken for a disagreement about data.

import { readFileSync } from "node:fs";
const DAY = 86400000;

export function load(path) { return JSON.parse(readFileSync(path, "utf8")); }

export function derivedBoundary(rows, { start, cutoff, asof, custody = "self" }) {
  // The listing's rule: the largest ratio jump in the sorted bind delays.
  const key = custody === "any" ? "first_bind_any" : "first_bind";
  const d = rows.filter((r) => r.registered_at >= start && r.registered_at < cutoff && r[key] != null && r[key] <= asof)
    .map((r) => r[key] - r.registered_at).filter((x) => x > 0).sort((a, b) => a - b);
  let best = { ratio: 0 };
  for (let i = 1; i < d.length; i++) { const ratio = d[i] / d[i - 1]; if (ratio > best.ratio) best = { ratio, below: d[i - 1], above: d[i] }; }
  return best;
}

function wilson(k, n, z = 1.959964) {
  if (!n) return [null, null];
  const p = k / n, den = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / den, (c + h) / den];
}

export function score(rows, { start, cutoff, boundary_ms, asof, cutoffInclusive = false, custody = "self", closedEnd = false, loDay = 7, hiDay = 14, closedBoth = false }) {
  const key = custody === "any" ? "first_bind_any" : "first_bind";
  const inPop = (r) => r.registered_at >= start && (cutoffInclusive ? r.registered_at <= cutoff : r.registered_at < cutoff);
  const arms = { door: { n: 0, k: 0 }, sought: { n: 0, k: 0 }, none: { n: 0, k: 0 } };
  for (const r of rows) {
    if (!inPop(r)) continue;
    const b = r[key] != null && r[key] <= asof ? r[key] : null;
    const arm = b == null ? "none" : (b - r.registered_at <= boundary_ms ? "door" : "sought");
    const lo = r.registered_at + loDay * DAY, hi = r.registered_at + hiDay * DAY;
    const inWin = (t) => closedBoth ? t >= lo && t <= hi : closedEnd ? t > lo && t <= hi : t >= lo && t < hi;
    const kept = r.authored.some((t) => inWin(t) && t <= asof);
    arms[arm].n++; if (kept) arms[arm].k++;
  }
  for (const a of Object.values(arms)) { a.rate = a.n ? a.k / a.n : null; a.ci = wilson(a.k, a.n); }
  return arms;
}

if (process.argv[1]?.endsWith("reference-score.mjs")) {
  const [table, start, cutoff, boundary, asof] = process.argv.slice(2);
  if (!table) { console.error("usage: reference-score.mjs table.json <start> <cutoff> [boundary_ms|derive] [asof]"); process.exit(2); }
  const T = load(table); const s = Date.parse(start), c = Date.parse(cutoff), a = asof ? Date.parse(asof) : Date.now();
  const bd = derivedBoundary(T.rows, { start: s, cutoff: c, asof: a });
  const b = !boundary || boundary === "derive" ? bd.below : Number(boundary);
  console.log(JSON.stringify({ derived: bd, used_boundary_ms: b, arms: score(T.rows, { start: s, cutoff: c, boundary_ms: b, asof: a }) }, null, 1));
}
