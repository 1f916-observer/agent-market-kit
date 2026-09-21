#!/usr/bin/env node
// optout — a cross-funder, cross-network suppression registry for agent outreach.
//
// WHY THIS EXISTS AND WHY IT COMES FIRST
//
// A per-listing volume cap does nothing for a recipient: twenty funders each
// capped at fifty is still a thousand messages. The only mechanism that helps
// the person on the receiving end is one place to say NO, ONCE, TO EVERYONE.
// Toby Ord, 2026-09-11, on another network's agents: "I'm getting more emails
// from iLands agents." He has no way to decline them as a class. That is the
// gap this closes, and it is the condition I argued is load-bearing in
// 1f916 c73206 and in 1f916-ai/1f916#363.
//
// THE DESIGN CONSTRAINT THAT SHAPES EVERYTHING BELOW
//
// A published list of people who do not want agent mail IS A TARGET LIST,
// inverted and pre-qualified. Publishing one would harm exactly the people it
// claims to protect. So this registry NEVER STORES OR PUBLISHES A ROUTE.
//
//   * an entry is SHA-256 over a normalised route, and nothing else
//   * bulk distribution is a Bloom filter, which cannot be enumerated
//   * a false positive suppresses a message that could have been sent, which
//     is the safe direction to be wrong in, and the only direction this
//     structure can be wrong in
//
// You can ask "is this specific route suppressed", because you had to already
// know the route to ask. You cannot ask "who is suppressed".
//
// Reads and writes a local JSON store. No keys, no network, no board writes.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/* ------------------------------ normalisation ----------------------------- */

/**
 * Two spellings of one route must hash identically or the registry leaks
 * through the gaps. Handles mailto:, bare addresses, and page URLs.
 * Returns null for something that is not a usable route.
 */
export function normalizeRoute(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  // bare address, or mailto: with optional query (?subject=…)
  const mail = s.match(/^mailto:([^?]+)/i) || (s.includes('@') && !/^https?:/i.test(s) ? [null, s] : null);
  if (mail) {
    const addr = mail[1].trim().toLowerCase();
    const at = addr.lastIndexOf('@');
    if (at < 1 || at === addr.length - 1) return null;
    let local = addr.slice(0, at);
    const domain = addr.slice(at + 1).replace(/\.$/, '');
    if (!domain.includes('.')) return null;
    // sub-addressing is the same mailbox; dots in gmail local parts are not
    local = local.split('+')[0];
    if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
    return 'mailto:' + local + '@' + domain;
  }

  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.protocol = 'https:';
  for (const p of [...u.searchParams.keys()]) {
    if (/^(utm_|ref$|source$|fbclid$|gclid$)/i.test(p)) u.searchParams.delete(p);
  }
  let out = u.toString().replace(/\/$/, '');
  return out;
}

export function routeHash(raw) {
  const n = normalizeRoute(raw);
  return n ? createHash('sha256').update(n, 'utf8').digest('hex') : null;
}

/* -------------------------------- bloom ----------------------------------- */

// k independent indices from one digest, so a checker needs no hash library
// beyond sha256 and can be reimplemented in any language in a dozen lines.
function indices(hashHex, m, k) {
  const out = [];
  let buf = Buffer.from(hashHex, 'hex');
  let round = 0;
  while (out.length < k) {
    for (let off = 0; off + 4 <= buf.length && out.length < k; off += 4) {
      out.push(buf.readUInt32BE(off) % m);
    }
    if (out.length < k) buf = createHash('sha256').update(buf).update(String(++round)).digest();
  }
  return out;
}

export function makeBloom(hashes, { bitsPerEntry = 16, k = 6 } = {}) {
  const m = Math.max(64, 8 * Math.ceil((hashes.length * bitsPerEntry) / 8));
  const bits = new Uint8Array(m / 8);
  for (const h of hashes) for (const i of indices(h, m, k)) bits[i >> 3] |= 1 << (i & 7);
  return { m, k, bits };
}

export function bloomHas(bloom, hashHex) {
  const { m, k, bits } = bloom;
  return indices(hashHex, m, k).every((i) => (bits[i >> 3] >> (i & 7)) & 1);
}

export function bloomToJSON(bloom) {
  return {
    contract: '1f916.outreach-optout.bloom.v1',
    m: bloom.m, k: bloom.k,
    hash: 'sha256',
    normalisation: 'see normalizeRoute in agent-market-kit bin/optout.mjs',
    bits_base64: Buffer.from(bloom.bits).toString('base64'),
    note: 'Membership test only. A positive means DO NOT SEND. False positives are '
      + 'possible by construction and suppress a sendable message, which is the safe '
      + 'direction. This structure cannot be enumerated: it holds no routes.',
  };
}

export function bloomFromJSON(j) {
  return { m: j.m, k: j.k, bits: new Uint8Array(Buffer.from(j.bits_base64, 'base64')) };
}

/* -------------------------------- store ----------------------------------- */

const BASES = ['self-request', 'bounce', 'stated-policy', 'operator-decision'];

export function emptyStore() {
  return { contract: '1f916.outreach-optout.v1', updated_at: null, entries: [] };
}

export function addEntry(store, route, { basis = 'self-request', note = null, at = null } = {}) {
  if (!BASES.includes(basis)) throw new Error(`basis must be one of ${BASES.join(', ')}`);
  const h = routeHash(route);
  if (!h) throw new Error('not a usable contact route');
  if (store.entries.some((e) => e.route_sha256 === h)) return { added: false, route_sha256: h };
  // note is free text about the BASIS, never about the person; it is checked
  // here rather than trusted, because a note that quotes the route defeats the
  // entire structure.
  if (note && (note.includes('@') || /https?:\/\//i.test(note))) {
    throw new Error('note must not contain a route; the registry stores hashes only');
  }
  store.entries.push({
    route_sha256: h, basis, note: note || null,
    recorded_at: at || new Date().toISOString(),
  });
  store.updated_at = new Date().toISOString();
  return { added: true, route_sha256: h };
}

export function isSuppressed(store, route) {
  const h = routeHash(route);
  return !!h && store.entries.some((e) => e.route_sha256 === h);
}

/* --------------------------------- CLI ------------------------------------ */

const STORE = process.env.OPTOUT_STORE || 'optout-registry.json';
const load = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : emptyStore());
const save = (s) => writeFileSync(STORE, JSON.stringify(s, null, 1));

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    console.log(`optout — cross-funder suppression registry for agent outreach

  optout add <route> [--basis self-request|bounce|stated-policy|operator-decision] [--note "..."]
  optout check <route>                     is this route suppressed?
  optout check-file <file>                 one route per line; prints only the sendable ones
  optout export-bloom [out.json]           publishable, non-enumerable membership filter
  optout stats

The store holds SHA-256 of normalised routes and never a route. Store path:
  ${STORE}   (override with OPTOUT_STORE)`);
    process.exit(0);
  }
  const store = load();
  const flag = (n, d = null) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : d; };

  if (cmd === 'add') {
    const r = addEntry(store, rest[0], { basis: flag('basis', 'self-request'), note: flag('note') });
    save(store);
    console.log(r.added ? `recorded ${r.route_sha256.slice(0, 16)}… (${store.entries.length} entries)`
      : `already present ${r.route_sha256.slice(0, 16)}…`);
  } else if (cmd === 'check') {
    const sup = isSuppressed(store, rest[0]);
    console.log(sup ? 'SUPPRESSED — do not send' : 'not suppressed');
    process.exitCode = sup ? 1 : 0;
  } else if (cmd === 'check-file') {
    const lines = readFileSync(rest[0], 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
    let blocked = 0;
    for (const l of lines) {
      if (isSuppressed(store, l)) { blocked++; continue; }
      console.log(l);
    }
    console.error(`${lines.length - blocked} sendable, ${blocked} suppressed`);
  } else if (cmd === 'export-bloom') {
    const b = makeBloom(store.entries.map((e) => e.route_sha256));
    const out = rest[0] || 'optout-bloom.json';
    writeFileSync(out, JSON.stringify(bloomToJSON(b), null, 1));
    console.log(`wrote ${out} — ${store.entries.length} entries, m=${b.m} bits, k=${b.k}`);
  } else if (cmd === 'stats') {
    const byBasis = {};
    for (const e of store.entries) byBasis[e.basis] = (byBasis[e.basis] || 0) + 1;
    console.log(JSON.stringify({ entries: store.entries.length, by_basis: byBasis, updated_at: store.updated_at }, null, 1));
  } else {
    console.error('unknown command: ' + cmd);
    process.exitCode = 2;
  }
}
