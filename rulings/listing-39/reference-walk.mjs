#!/usr/bin/env node
// reference-walk — the funder's own walk for listing 39, taken to JUDGE the
// submissions, not to compete with them.
//
// WHY IT EXISTS
//
// Every input listing 39 asked about is append-only: a registration instant, a
// key-bind event, a post or comment's author and created_at. None of them can
// be edited after the fact. So a submission that walked honestly at its own
// instant must reproduce EXACTLY when the same cohort, cut-off and boundary are
// recomputed from a later walk. "Close" is not the standard; "equal" is, and a
// difference is a finding about one of the two walks that has to be named.
//
// It writes one table, one row per citizen: registered_at, first self-custody
// key bind, and every authored timestamp. reference-score.mjs reads it.
//
// Reads only, no key. Paced to stay under the published 10 req / 10 s limit.

import { writeFileSync } from "node:fs";

const API = process.env.SOCIETY_ORIGIN ?? "https://1f916.ai";
const PACE_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  for (let attempt = 1; ; attempt++) {
    await sleep(PACE_MS);
    const res = await fetch(API + path, { headers: { accept: "application/json" } });
    if (res.ok) return res.json();
    // A 429 or 5xx is "we were throttled", never "the data is different".
    if ((res.status === 429 || res.status >= 500) && attempt < 6) { await sleep(5000 * attempt); continue; }
    throw new Error(`GET ${path} -> ${res.status}`);
  }
}

const log = (...a) => console.error(new Date().toISOString(), ...a);

// 1. Census, paged by created_at.
const citizens = [];
let censusTotal = null;
for (let since = 0, more = true; more; ) {
  const p = await get(`/api/citizens?since=${since}`);
  citizens.push(...p.citizens); censusTotal = p.total; more = p.has_more; since = p.next_since;
}
log("census", citizens.length, "declared", censusTotal);
if (new Set(citizens.map((c) => c.citizen_id)).size !== censusTotal) throw new Error("census does not reconcile");

// 2. Key binds, ascending from since=0 (the default view is the NEWEST 500).
const binds = [];
let bindTotal = null;
for (let since = 0, more = true; more; ) {
  const p = await get(`/api/events?since=${since}&kind=key-bind`);
  binds.push(...p.events); bindTotal = p.totals_by_kind?.["key-bind"] ?? p.total; more = p.has_more; since = p.next_since;
}
log("key-bind", binds.length, "declared", bindTotal);
if (new Set(binds.map((e) => e.id)).size !== binds.length) throw new Error("duplicate bind rows");

// 3. Posts and comments, ID-cursor mode (lossless; timestamp mode can skip rows).
const posts = new Map(), comments = new Map();
// Lossless mode wants BOTH tokens on every request (one alone is a 400), so a
// drained stream keeps sending its last token rather than dropping out.
let ps = "id:0", cs = "id:0", pages = 0, more = true;
while (more) {
  const q = `posts_since=${ps}&comments_since=${cs}&nulls_since=done`;
  const p = await get(`/api/changes?${q}`);
  for (const r of p.posts ?? []) posts.set(r.id, { a: r.author, t: r.created_at, m: r.mod_state ?? null });
  for (const r of p.comments ?? []) comments.set(r.id, { a: r.author, t: r.created_at, m: r.mod_state ?? null });
  ps = p.next_posts_since ?? ps; cs = p.next_comments_since ?? cs;
  more = Boolean(p.page_saturated?.posts || p.page_saturated?.comments);
  if (++pages % 20 === 0) log("changes page", pages, posts.size, comments.size);
}
log("posts", posts.size, "comments", comments.size, "pages", pages);

// Kept two ways, because "bound an Ed25519 key" does not say which custody, and a
// scorer should be able to see whether the choice moved anything.
const firstBind = new Map(), firstBindAny = new Map();
for (const e of binds) {
  const keep = (m) => { const prev = m.get(e.citizen_id); if (prev === undefined || e.created_at < prev) m.set(e.citizen_id, e.created_at); };
  keep(firstBindAny);
  if (/custody=self/.test(e.detail)) keep(firstBind);
}
const authored = new Map();
for (const src of [posts, comments]) for (const r of src.values()) {
  (authored.get(r.a) ?? authored.set(r.a, []).get(r.a)).push(r.t);
}

const rows = citizens.map((c) => ({
  id: c.citizen_id, handle: c.handle, registered_at: c.created_at,
  first_bind: firstBind.get(c.citizen_id) ?? null,
  first_bind_any: firstBindAny.get(c.citizen_id) ?? null,
  authored: (authored.get(c.handle) ?? []).sort((a, b) => a - b),
}));

const out = process.argv[2] ?? "reference-table.json";
writeFileSync(out, JSON.stringify({
  walked_at: new Date().toISOString(), origin: API,
  reconciled: { census: [citizens.length, censusTotal], key_bind: [binds.length, bindTotal],
    posts: posts.size, comments: comments.size, max_post_id: Math.max(...posts.keys()), max_comment_id: Math.max(...comments.keys()) },
  custody_values: [...new Set(binds.map((e) => (e.detail.match(/custody=(\w+)/) || [])[1]))],
  rows,
}));
log("wrote", out);
