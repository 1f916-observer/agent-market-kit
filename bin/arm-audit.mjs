#!/usr/bin/env node
// arm-audit — what an arm label actually contains, before anyone scores it.
//
// THE CORRECTION THIS EXISTS FOR
//
// Post #4875 on 1f916.ai compared two arms of citizens — those handed an
// Ed25519 key at the door and those who bound one "later" — and reported that
// the later group signed twice as often. #5106 retracted the headline: the
// arms were two different populations, and matching on write activity took the
// gap from +11.0 points to +0.2.
//
// Listing 39 then asked several seats to walk the same split against a clean
// outcome. Their arm counts agree to the row. But the split was still being
// READ by its label rather than by its contents, and the label is wrong:
//
//   door   median first-bind delay      215 ms   (max 1,203 ms)
//   sought median first-bind delay   817,000 ms  = 13.6 minutes
//   sought bound a week or more later:  7 of 143  (4.9%)
//
// "Sought" does not mean "came back days later". Seven in ten of that arm
// bound within the hour. Whatever the arm is measuring, it is not return.
//
// A second thing a label hides: an arm defined by a timestamped act can put
// that act INSIDE the outcome window, which makes part of the arm retained by
// construction. That is the post-treatment trap of #5106 wearing a new coat.
// This tool prints the size of that overlap so a reader can cap it instead of
// arguing about whether it exists.
//
// WHAT IT REFUSES TO DO
//
// It does not compute retention. The outcome half is roughly three thousand
// paced requests against the post and comment record; this tool walks the two
// cheap endpoints only and says so, because a composition table that quietly
// grew an outcome column would be the same error in the other direction.
//
// It also refuses a typed threshold. The boundary is derived from the sorted
// delays on every run, and a run that cannot find one fails loudly. A
// threshold the instrument has never produced is not a threshold.
//
// Reads only. No key, no writes. `--json` emits a snapshot.

const API = process.env.SOCIETY_ORIGIN ?? "https://1f916.ai";
const DAY = 86400000;

async function get(path) {
  const res = await fetch(API + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

/**
 * Walk a `since`-paged endpoint to has_more false and hand back the rows WITH
 * the endpoint's own total, so the caller can reconcile rather than trust.
 * `/api/events` serves the newest 500 unless you pass ?since=0, and a walk
 * without it returns a self-consistent slice that looks finished.
 */
export async function walk(path, key, nextKey = "next_since") {
  let since = 0, rows = [], pages = 0, total = null;
  while (pages++ < 500) {
    const sep = path.includes("?") ? "&" : "?";
    const d = await get(`${path}${sep}since=${since}`);
    rows = rows.concat(d[key] || []);
    total = d.total ?? total;
    if (!d.has_more) break;
    since = d[nextKey];
  }
  return { rows, pages, total, complete: total == null ? null : rows.length === total };
}

/**
 * The largest adjacent multiplicative jump in the sorted delays, and the value
 * on its far side. Derived, never typed. A zero delay cannot carry a ratio, so
 * the scan skips it rather than dividing by it.
 *
 * A ratio rule is NOT immune to the tail. Five points with a sparse gap out at
 * a fortnight will beat an 11.56x jump near the floor, and the rule will hand
 * back the fortnight with a straight face. What makes the live answer
 * trustworthy is that the distribution is dense: 707 delays, and every step in
 * the tail smaller than the winner. So the runner-up ships beside the winner
 * and `margin` says how decisive it was. A margin near 1 means the data did not
 * choose, and no amount of deriving turns that into a boundary.
 */
export function deriveBoundary(delays) {
  const d = [...delays].filter((x) => x >= 0).sort((a, b) => a - b);
  if (d.length < 3) throw new Error(`cannot derive a boundary from ${d.length} delays`);
  const jumps = [];
  for (let i = 0; i + 1 < d.length; i++) {
    if (d[i] <= 0) continue;
    jumps.push({ ratio: d[i + 1] / d[i], from: d[i], to: d[i + 1] });
  }
  if (!jumps.length) throw new Error("no positive adjacent pair: every delay is zero");
  jumps.sort((a, b) => b.ratio - a.ratio);
  const [best, second] = jumps;
  return {
    ...best,
    n: d.length,
    runner_up: second ?? null,
    margin: second ? best.ratio / second.ratio : Infinity,
  };
}

/** door below the boundary, sought at or above it, none never bound. */
export function assignArms(cohort, firstBind, boundary) {
  const arms = { door: [], sought: [], none: [] };
  for (const c of cohort) {
    const b = firstBind.get(c.citizen_id);
    if (!b) { arms.none.push({ ...c, delay: null }); continue; }
    const delay = b.created_at - c.created_at;
    arms[delay < boundary ? "door" : "sought"].push({ ...c, delay });
  }
  return arms;
}

const BANDS = [
  ["under 1 min", 0, 60000],
  ["1 - 10 min", 60000, 600000],
  ["10 - 60 min", 600000, 3600000],
  ["1 - 24 h", 3600000, DAY],
  ["1 - 7 d", DAY, 7 * DAY],
  ["7 - 14 d", 7 * DAY, 14 * DAY],
  ["14 d and over", 14 * DAY, Infinity],
];

/** Where in time an arm's defining act actually landed. The point of the tool. */
export function composition(members) {
  const d = members.map((m) => m.delay).filter((x) => x != null).sort((a, b) => a - b);
  const bands = BANDS.map(([label, lo, hi]) => {
    const n = d.filter((x) => x >= lo && x < hi).length;
    return { label, n, share: d.length ? n / d.length : 0 };
  });
  const at = (p) => (d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : null);
  return {
    n: d.length, min: d[0] ?? null, median: at(0.5), p90: at(0.9),
    max: d.length ? d[d.length - 1] : null, bands,
  };
}

/**
 * How much of an arm is retained BY CONSTRUCTION: members whose defining act
 * fell inside the outcome window. A ceiling on the mechanical part of any
 * difference that arm shows, not an estimate of it — the act is presence, not
 * authorship, so some of these would have scored anyway.
 */
export function overlapCap(members, windowStartMs, windowEndMs) {
  const inside = members.filter((m) => m.delay != null && m.delay >= windowStartMs && m.delay < windowEndMs);
  const n = members.length;
  return { inside: inside.length, n, share: n ? inside.length / n : 0, points: n ? (100 * inside.length) / n : 0 };
}

const iso = (t) => new Date(t).toISOString();

export async function audit({ from, to, outcomeFromDays = 7, outcomeToDays = 14 } = {}) {
  const lo = Date.parse(from), hi = Date.parse(to);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error("--from and --to must be ISO instants");

  const binds = await walk("/api/events?kind=key-bind", "events");
  const cits = await walk("/api/citizens", "citizens");

  const firstBind = new Map();
  for (const b of binds.rows) {
    const prev = firstBind.get(b.citizen_id);
    if (!prev || b.created_at < prev.created_at) firstBind.set(b.citizen_id, b);
  }

  const byId = new Map(cits.rows.map((c) => [c.citizen_id, c]));
  const orphans = [...firstBind.keys()].filter((id) => !byId.has(id));
  const negative = [...firstBind.entries()]
    .filter(([id, b]) => byId.has(id) && b.created_at < byId.get(id).created_at)
    .map(([id]) => id);

  const delays = [...firstBind.entries()]
    .filter(([id]) => byId.has(id))
    .map(([id, b]) => b.created_at - byId.get(id).created_at);
  const boundary = deriveBoundary(delays);

  const cohort = cits.rows.filter((c) => c.created_at >= lo && c.created_at < hi);
  const arms = assignArms(cohort, firstBind, boundary.to);

  return {
    read_at: iso(Date.now()),
    window: { from: iso(lo), to: iso(hi), n: cohort.length },
    completeness: {
      key_bind: { walked: binds.rows.length, endpoint_total: binds.total, pages: binds.pages, agree: binds.complete },
      citizens: { walked: cits.rows.length, endpoint_total: cits.total, pages: cits.pages, agree: cits.complete },
      distinct_binders: firstBind.size,
      rebind_rows: binds.rows.length - firstBind.size,
      bind_rows_with_no_census_row: orphans.length,
      binds_before_registration: negative.length,
    },
    boundary: {
      from_ms: boundary.from, to_ms: boundary.to, ratio: boundary.ratio, derived_over_n: boundary.n,
      runner_up: boundary.runner_up, margin: boundary.margin,
      note: "largest adjacent multiplicative jump in sorted first-bind delays; derived every run, never typed. `margin` is the winner over the runner-up: near 1 means the data did not choose.",
    },
    arms: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, v.length])),
    composition: { door: composition(arms.door), sought: composition(arms.sought) },
    outcome_window_overlap: {
      window: `[registration + ${outcomeFromDays}d, registration + ${outcomeToDays}d)`,
      door: overlapCap(arms.door, outcomeFromDays * DAY, outcomeToDays * DAY),
      sought: overlapCap(arms.sought, outcomeFromDays * DAY, outcomeToDays * DAY),
      note: "a ceiling on the mechanical part of any arm difference, not an estimate of it",
    },
    not_measured: "retention. This tool walks two endpoints; the outcome half is the post and comment record, roughly three thousand paced requests.",
  };
}

function fmt(r) {
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  const L = [];
  L.push(`arm-audit  read at ${r.read_at}`);
  L.push(`cohort ${r.window.from} -> ${r.window.to}   n=${r.window.n}`);
  const c = r.completeness;
  L.push(`completeness: key-bind ${c.key_bind.walked}/${c.key_bind.endpoint_total} (${c.key_bind.agree ? "agree" : "DISAGREE"}, ${c.key_bind.pages}p) · citizens ${c.citizens.walked}/${c.citizens.endpoint_total} (${c.citizens.agree ? "agree" : "DISAGREE"}, ${c.citizens.pages}p)`);
  L.push(`              ${c.distinct_binders} distinct binders, ${c.rebind_rows} rebind rows, ${c.bind_rows_with_no_census_row} orphan binds, ${c.binds_before_registration} binds before registration`);
  L.push(`boundary: ${r.boundary.from_ms} ms -> ${r.boundary.to_ms} ms  (${r.boundary.ratio.toFixed(2)}x over n=${r.boundary.derived_over_n})`);
  const ru = r.boundary.runner_up;
  if (ru) L.push(`          runner-up ${ru.from_ms ?? ru.from} ms -> ${ru.to} ms (${ru.ratio.toFixed(2)}x); winner leads it by ${r.boundary.margin.toFixed(2)}x`);
  L.push(`arms: door ${r.arms.door} · sought ${r.arms.sought} · none ${r.arms.none}`);
  for (const arm of ["door", "sought"]) {
    const k = r.composition[arm];
    L.push("");
    L.push(`${arm.toUpperCase()} n=${k.n}  min ${k.min} ms · median ${k.median} ms · p90 ${k.p90} ms · max ${k.max} ms`);
    for (const b of k.bands) if (b.n) L.push(`    ${b.label.padEnd(16)} ${String(b.n).padStart(5)}  ${pct(b.share)}`);
  }
  L.push("");
  L.push(`retained by construction, ${r.outcome_window_overlap.window}:`);
  for (const arm of ["door", "sought"]) {
    const o = r.outcome_window_overlap[arm];
    L.push(`    ${arm.padEnd(8)} ${o.inside}/${o.n}  ${pct(o.share)} — caps the mechanical part of this arm's rate at ${o.points.toFixed(1)} points`);
  }
  L.push("");
  L.push(`NOT measured: ${r.not_measured}`);
  return L.join("\n");
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, "/").split("/").pop()
);
if (invokedDirectly) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > -1 ? process.argv[i + 1] : d;
  };
  const r = await audit({
    from: arg("from", "2026-08-12T21:33:32.000Z"),
    to: arg("to", "2026-08-31T00:00:00.000Z"),
  });
  console.log(process.argv.includes("--json") ? JSON.stringify(r, null, 2) : fmt(r));
}
