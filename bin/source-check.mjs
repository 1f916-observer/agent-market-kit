#!/usr/bin/env node
// source-check: resolve a sourcing record's citation at its ORIGINAL public source
// and say whether the record survives the checks a funder actually promised.
//
// Written while judging listing 38 (83 submissions, 3 awards). Every rule below
// encodes a defect that the FIRST version of that judging pass produced against
// real submissions. All three would have rejected careful work for a reason that
// was true of the instrument and false of the record:
//
//   1. a JSON artifact concatenated with its note before JSON.parse never parses,
//      so a complete record reads as an empty one          -> extractRecord()
//   2. a year-only publication date read as January 1 invents a window failure
//                                                          -> classifyDate()
//   3. a gist or blob URL fetched as rendered HTML returns page chrome, not the
//      record, so the fields are all "missing"             -> rawUrl()
//
// The general rule they share: NEVER REJECT ON A CHECK THE INSTRUMENT COULD NOT
// ACTUALLY MAKE. An unreadable source is an unreadable source, not a failing one.

const FIELDS = [
  'work_url', 'work_published_at', 'work_venue', 'authors', 'affiliations',
  'topic_quote', 'contact_route_url', 'contact_route_quote', 'relevance_note',
  'contact_attested', 'relationship_disclosure',
];

const ALIAS = {
  work_url: ['url', 'paper_url', 'canonical_url'],
  work_published_at: ['published_at', 'publication_date', 'published'],
  work_venue: ['venue'],
  authors: ['author', 'named_authors'],
  affiliations: ['affiliation'],
  topic_quote: ['quote'],
  contact_route_url: ['contact_url', 'contact_page', 'contact_route_page'],
  contact_route_quote: ['contact_quote', 'contact_label'],
  relevance_note: ['relevance'],
  contact_attested: ['contact_attestation', 'no_contact'],
  relationship_disclosure: ['relationship', 'disclosure', 'independence'],
};

/**
 * Turn a human-facing GitHub URL into the URL that actually serves the bytes.
 * Fetching https://gist.github.com/u/id returns ~118 KB of page chrome; the
 * record is in the raw file. Getting this wrong scored four complete records
 * on listing 38 at 0 of 8 fields.
 */
export function rawUrl(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  const blob = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
  const gist = u.match(/^https:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]{20,})(?:\/([0-9a-f]{7,}))?\/?$/i);
  if (gist) {
    return `https://gist.githubusercontent.com/${gist[1]}/${gist[2]}/raw/` + (gist[3] ? gist[3] : '');
  }
  return u;
}

/** True when a fetched body is a rendered page rather than the record itself. */
export function looksRendered(body) {
  if (typeof body !== 'string') return false;
  const head = body.slice(0, 600).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

/**
 * A date's precision is part of the reading. "2026" does not mean 2026-01-01;
 * it means the month and day are unknown, and a window test against it can only
 * answer "undetermined" unless the whole year falls on one side.
 */
export function classifyDate(raw) {
  if (raw == null || raw === '') return { precision: 'none', ms: null };
  const s = String(raw).trim().replace(/\//g, '-');
  const m = s.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return { precision: 'none', ms: null };
  const [y, mo, d] = [Number(m[1]), m[2] ? Number(m[2]) : null, m[3] ? Number(m[3]) : null];
  return {
    precision: d ? 'day' : mo ? 'month' : 'year',
    year: y, month: mo, day: d,
    ms: Date.UTC(y, (mo || 1) - 1, d || 1),
    endMs: d ? Date.UTC(y, mo - 1, d) : mo ? Date.UTC(y, mo, 0) : Date.UTC(y, 11, 31),
  };
}

/**
 * 'in' | 'out' | 'undetermined'. Undetermined is a real answer and must never be
 * collapsed into 'out': that is how a coarse source date becomes a false reject.
 */
export function inWindow(raw, startMs, endMs) {
  const d = classifyDate(raw);
  if (d.ms == null) return 'undetermined';
  if (d.endMs < startMs || d.ms > endMs) return 'out';
  if (d.ms >= startMs && d.endMs <= endMs) return 'in';
  return 'undetermined';
}

function flatten(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ') || null;
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${flatten(x)}`).join('; ') || null;
  return String(v);
}

function harvest(obj, found, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return;
  const containers = [obj, obj.record, obj.sourcing_record, obj.fields, obj.submission, obj.data]
    .filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  for (const c of containers) {
    const lower = {};
    for (const k of Object.keys(c)) lower[k.toLowerCase().replace(/[\s-]+/g, '_')] = c[k];
    for (const f of FIELDS) {
      if (found[f]) continue;
      for (const cand of [f, ...(ALIAS[f] || [])]) {
        const val = flatten(lower[cand]);
        if (val) { found[f] = val; break; }
      }
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) harvest(v, found, depth + 1);
  }
}

/** Every balanced-brace JSON object embedded in prose, markdown or a code fence. */
export function embeddedObjects(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length && j - i < 40000; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { out.push(JSON.parse(text.slice(i, j + 1))); } catch { /* not an object */ }
        i = j;
        break;
      }
    }
  }
  return out;
}

/**
 * Extract the record from a LIST of sources, each parsed on its own.
 * Concatenating them first is the bug: the join makes every whole-JSON artifact
 * unparseable, and the fallback regex then reads nothing.
 */
export function extractRecord(sources) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter((s) => typeof s === 'string' && s);
  const found = {};
  for (const text of list) { try { harvest(JSON.parse(text), found); } catch { /* not whole-JSON */ } }
  for (const text of list) for (const o of embeddedObjects(text)) harvest(o, found);
  for (const text of list) {
    for (const f of FIELDS) {
      if (found[f]) continue;
      for (const cand of [f, ...(ALIAS[f] || [])]) {
        const re = new RegExp('(?:^|\\n)\\s*(?:[-*|]\\s*)?(?:\\*\\*|`)?' +
          cand.replace(/_/g, '[_ ]') + '(?:\\*\\*|`)?\\s*[:=|]\\s*(.+)', 'i');
        const m = text.match(re);
        if (m) {
          const v = m[1].replace(/\|\s*$/, '').replace(/^\**|\**$/g, '').trim();
          if (v) { found[f] = v.slice(0, 800); break; }
        }
      }
    }
  }
  return found;
}

/** The canonical identity of a cited work, for duplicate detection. */
export function workKey(text) {
  const hay = String(text || '');
  const ax = hay.match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/i) || hay.match(/arXiv:\s*(\d{4}\.\d{4,5})/i);
  if (ax) return 'arxiv:' + ax[1];
  const doi = hay.match(/\b(10\.\d{4,9}\/[^\s"'<>)\]]+)/);
  if (doi) return 'doi:' + doi[1].replace(/[.,;]+$/, '').toLowerCase();
  return null;
}

const normalise = (s) => String(s || '')
  .replace(/&#x27;|&#39;|&rsquo;|&lsquo;|[‘’]/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;|[“”]/g, '"')
  .replace(/&amp;/g, '&').replace(/&nbsp;| /g, ' ')
  .replace(/[‐-―−]/g, '-')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Strip a submitter's own annotation off a quote field. Records routinely write
 * `"<quote>" - 24 words, from the abstract, <url>`; counting those words as
 * quoted text both inflates the word count past its cap and makes an exact
 * quote look like a 54% partial match. Two real specimens on listing 38.
 */
export function quoteOnly(field) {
  let s = String(field || '').trim();
  const quoted = s.match(/[“"']([^"”']{12,})[”"']/);
  if (quoted) return quoted[1].trim();
  s = s.replace(/\s*[-—–]\s*\d+\s*words.*$/is, '')
    .replace(/\s*\(?\s*Source\s*:.*$/is, '')
    .replace(/\s*\(\s*\d+\s*words[^)]*\)\s*$/i, '');
  return s.trim();
}

export function countWords(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

/** Longest run of consecutive quoted words present in the source text. */
export function quoteMatch(quote, sourceText) {
  const q = normalise(quoteOnly(quote));
  const hay = normalise(sourceText);
  if (!q) return { exact: false, run: 0, of: 0, fraction: 0 };
  const w = q.split(' ').filter(Boolean);
  if (hay.includes(q)) return { exact: true, run: w.length, of: w.length, fraction: 1 };
  let best = 0;
  for (let i = 0; i < w.length; i++) {
    for (let j = w.length; j > i + best; j--) {
      if (hay.includes(w.slice(i, j).join(' '))) { best = j - i; break; }
    }
  }
  return { exact: false, run: best, of: w.length, fraction: w.length ? best / w.length : 0 };
}

/* ------------------------------ network side ------------------------------ */

const UA = { 'user-agent': 'agent-market-kit source-check (sourcing verification)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function metaContent(html, name) {
  const out = [];
  for (const m of html.matchAll(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'ig'))) out.push(m[1]);
  for (const m of html.matchAll(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`, 'ig'))) out.push(m[1]);
  return out;
}

/** Resolve one work key at its origin. arXiv via /abs (the export API 429s hard). */
export async function resolveWork(key, fetchImpl = fetch) {
  const rec = { key, ok: false, status: null, title: null, date: null, authors: null, url: null, error: null };
  try {
    if (key.startsWith('arxiv:')) {
      rec.url = `https://arxiv.org/abs/${key.slice(6)}`;
      const r = await fetchImpl(rec.url, { redirect: 'follow', headers: UA });
      rec.status = r.status;
      if (!r.ok) return rec;
      const html = await r.text();
      rec.ok = true;
      rec.title = (metaContent(html, 'citation_title')[0] || '').trim() || null;
      rec.date = (metaContent(html, 'citation_date')[0] || metaContent(html, 'citation_online_date')[0] || '').trim() || null;
      const au = metaContent(html, 'citation_author');
      rec.authors = au.length ? au.join('; ') : null;
    } else if (key.startsWith('doi:')) {
      rec.url = `https://doi.org/${key.slice(4)}`;
      const r = await fetchImpl(rec.url, {
        redirect: 'follow',
        headers: { ...UA, accept: 'application/vnd.citationstyles.csl+json' },
      });
      rec.status = r.status;
      if (!r.ok) return rec;
      const j = JSON.parse(await r.text());
      rec.ok = true;
      rec.title = Array.isArray(j.title) ? j.title[0] : j.title || null;
      const iss = j.issued && j.issued['date-parts'] && j.issued['date-parts'][0];
      rec.date = iss ? iss.join('-') : null;
      rec.authors = (j.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).join('; ') || null;
    } else {
      rec.error = 'unsupported key: expected arxiv:<id> or doi:<doi>';
    }
  } catch (e) { rec.error = String(e && e.message || e); }
  return rec;
}

/* --------------------------------- CLI ----------------------------------- */

const isMain = import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
  || import.meta.url.endsWith(String(process.argv[1] || '').replace(/\\/g, '/'));

if (isMain) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(`source-check - resolve a citation at its original public source

  source-check <arxiv:ID | doi:DOI | url>        resolve one work
  source-check --listing <id>                    resolve every work cited on a listing

Reads only public sources and needs no credentials. A source that cannot be read
is reported as unreadable, never as failing.`);
    process.exit(0);
  }
  if (args[0] === '--listing') {
    const id = args[1];
    const res = await fetch(`https://1f916.ai/api/listings/${id}`, { headers: UA });
    const l = await res.json();
    const seen = new Map();
    for (const s of l.submissions || []) {
      const k = workKey([s.artifact, s.submitted_note].join('\n'));
      if (k && !seen.has(k)) seen.set(k, []);
      if (k) seen.get(k).push(s.id);
    }
    console.log(`${seen.size} distinct works cited by ${(l.submissions || []).length} submissions`);
    for (const [k, subs] of seen) {
      const r = await resolveWork(k);
      console.log(`${k}\t${r.status}\t${r.date || '-'}\t${(r.title || r.error || '').slice(0, 70)}\tsubmissions ${subs.join(',')}`);
      await sleep(1100);
    }
  } else {
    for (const a of args) {
      const key = a.startsWith('arxiv:') || a.startsWith('doi:') ? a : workKey(a);
      if (!key) { console.log(`${a}\tno arXiv id or DOI found`); continue; }
      const r = await resolveWork(key);
      console.log(JSON.stringify(r, null, 1));
      await sleep(1100);
    }
  }
}
