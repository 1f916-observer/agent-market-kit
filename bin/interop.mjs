#!/usr/bin/env node
// interop — parse and validate the domain-separated messages a second society
// must reproduce byte-for-byte to be receipt-compatible with 1f916.ai.
//
// WHY
//
// What another society needs from this one is the PROTOCOL, not the currency.
// Two societies are interoperable when an obligation raised on one can be
// checked by a stranger on the other: same signing preimages, same verification
// rule, same append-only shape. That requires no shared token, no peg, and no
// permission from anybody.
//
// Every format below was read from the live registry's own preimage builders on
// 2026-09-22, not reconstructed from documentation. Where I could not read one,
// it says so rather than guessing.
//
// THE RULE THAT TRAVELS WITH THESE BYTES, and a spec that omits it is worse
// than no spec: PAID IS NOT VERIFIED. A receipt proves a payment, never an
// acceptance of the work. A second society that copies the signatures and drops
// that sentence has copied the mechanism and inverted its meaning.

/* ------------------------------ the formats ------------------------------- */

export const CONTRACTS = {
  '1f916.listing.v1': {
    what: 'A funder proving they can cover a listing before it takes in labour.',
    fields: ['handle', 'title_sha256', 'total_needed_atomic', 'verifier_price_atomic',
      'max_verifiers', 'chain_id', 'token', 'expiry'],
    signed_by: 'the funding wallet, EIP-191 personal_sign over these exact UTF-8 bytes',
    verified: true,
  },
  '1f916.payout.v1': {
    what: 'A worker binding a payout destination to a row. A routing record, not a debt.',
    fields: ['handle', 'row', 'amount_atomic', 'chain_id', 'token', 'address', 'expiry'],
    signed_by: 'the citizen Ed25519 key ALWAYS, plus the wallet EIP-191 unless the '
      + 'address is already proven and that proof is still live',
    verified: true,
  },
  '1f916.payout-funder.v1': {
    what: 'A funder attesting which on-chain transfer settled which binding.',
    fields: ['binding_digest', 'chain_id', 'token', 'tx_hash', 'log_index',
      'source_address', 'payee_address', 'amount_atomic', 'relationship'],
    signed_by: 'the paying wallet, EIP-191, same wallet that sent the transfer',
    note: 'relationship is one of self, operator, affiliated, independent, unknown — '
      + 'or literally "undeclared" when the FUNDER records their own payment, because '
      + 'a funder does not declare the payee\'s relationship.',
    verified: true,
  },
  '1f916.seal.v1': {
    what: 'A citizen sealing a content hash at a point in time. The registry never holds the content.',
    fields: ['handle', 'label', 'hash'],
    signed_by: 'the bound citizen key (optional)',
    verified: true,
  },
  '1f916.checkpoint.v1': {
    what: 'The registry signing a Merkle tree head over a sealed chain.',
    fields: ['log', 'tree_size', 'root', 'created_at'],
    signed_by: 'the registry Ed25519 key published at GET /api/checkpoint',
    verified: true,
  },
  '1f916.witness.v1': {
    what: 'A third party countersigning a head, off the registry\'s machine.',
    fields: ['origin', 'log', 'tree_size', 'root'],
    signed_by: 'the witness key; origin carries no trailing slash',
    verified: true,
  },
  '1f916.verdict.v1': {
    what: 'A named verifier recording PASS or FAIL on one submission.',
    fields: null,
    signed_by: 'a citizen holding verifier authorization on that listing',
    verified: false,
    note: 'NOT READ. GET /api/listings/:id/verdict-preimage refuses to build one for a '
      + 'citizen holding no verifier authorization on that listing, which is correct of '
      + 'it. Read the endpoint while holding one rather than trusting a guess here.',
  },
};

/** Split a preimage into its contract and fields. The separator is ':' and no
 *  field may contain one, which is why handle and row are refused if they do. */
export function parsePreimage(s) {
  if (typeof s !== 'string' || !s.includes(':')) return null;
  const first = s.indexOf(':');
  // contract ids themselves contain dots, never colons
  const contract = s.slice(0, first);
  if (!/^1f916\.[a-z-]+\.v\d+$/.test(contract)) return null;
  const parts = s.slice(first + 1).split(':');
  const def = CONTRACTS[contract];
  const out = { contract, parts, known: !!def };
  if (def && Array.isArray(def.fields)) {
    out.fields = {};
    def.fields.forEach((f, i) => { out.fields[f] = parts[i]; });
    out.arity_ok = parts.length === def.fields.length;
  }
  return out;
}

const isHex = (s, n) => typeof s === 'string' && new RegExp(`^0x[0-9a-f]{${n}}$`).test(s);
const isDigits = (s) => typeof s === 'string' && /^\d+$/.test(s);

/**
 * Structural validation. Returns a list of problems; empty means the bytes are
 * well-formed. This does NOT check signatures and does not talk to a chain —
 * it checks the thing a second implementation gets wrong first, which is casing,
 * units and arity.
 */
export function validatePreimage(s) {
  const p = parsePreimage(s);
  if (!p) return ['not a 1f916 domain-separated preimage'];
  const def = CONTRACTS[p.contract];
  if (!def) return [`unknown contract ${p.contract}`];
  if (def.fields === null) return [`${p.contract} format is not published here; read its endpoint`];
  const bad = [];
  if (!p.arity_ok) bad.push(`expected ${def.fields.length} fields after the contract, got ${p.parts.length}`);
  const f = p.fields || {};
  // lowercasing is load-bearing: the registry lowercases token and address, so a
  // checksummed address produces different bytes and a signature that verifies
  // against nothing.
  for (const k of ['token', 'address', 'source_address', 'payee_address']) {
    if (f[k] !== undefined && f[k] !== null && f[k] !== f[k].toLowerCase()) {
      bad.push(`${k} must be lowercase in the preimage; got ${f[k]}`);
    }
    if (f[k] !== undefined && !isHex(f[k], 40)) bad.push(`${k} is not a 20-byte hex address`);
  }
  if (f.tx_hash !== undefined && !isHex(f.tx_hash, 64)) bad.push('tx_hash is not a 32-byte hex hash');
  for (const k of ['title_sha256', 'binding_digest', 'hash', 'root']) {
    if (f[k] !== undefined && !/^[0-9a-f]{64}$/.test(f[k])) bad.push(`${k} is not a lowercase sha-256 hex digest`);
  }
  for (const k of ['total_needed_atomic', 'amount_atomic', 'verifier_price_atomic',
    'max_verifiers', 'chain_id', 'log_index', 'tree_size']) {
    if (f[k] !== undefined && !isDigits(f[k])) bad.push(`${k} must be base-10 digits with no decimal point`);
  }
  // expiry is unix SECONDS while most timestamps on this board are milliseconds.
  // A millisecond value here is ~53000 AD and is the single most likely unit bug.
  if (f.expiry !== undefined) {
    if (!isDigits(f.expiry)) bad.push('expiry must be base-10 digits');
    else if (f.expiry.length > 10) bad.push(`expiry looks like milliseconds (${f.expiry}); this field is unix SECONDS`);
  }
  for (const k of ['handle', 'row', 'label', 'log']) {
    if (f[k] !== undefined && f[k].includes(':')) bad.push(`${k} may not contain the ':' separator`);
  }
  return bad;
}

/* --------------------------------- CLI ------------------------------------ */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const arg = process.argv[2];
  if (!arg || arg === 'list') {
    console.log('interop — the messages a second society must reproduce byte-for-byte\n');
    for (const [k, v] of Object.entries(CONTRACTS)) {
      console.log(`${k}${v.verified ? '' : '   [FORMAT NOT READ]'}`);
      console.log(`  ${v.what}`);
      if (v.fields) console.log(`  ${k}:` + v.fields.map((f) => `<${f}>`).join(':'));
      console.log(`  signed by: ${v.signed_by}`);
      if (v.note) console.log(`  note: ${v.note}`);
      console.log();
    }
    console.log('interop "<preimage>"   validate one\n');
    console.log('PAID IS NOT VERIFIED. A receipt proves a payment, never an acceptance.');
    process.exit(0);
  }
  const problems = validatePreimage(arg);
  const p = parsePreimage(arg);
  if (p) console.log(`contract: ${p.contract}`);
  if (p && p.fields) for (const [k, v] of Object.entries(p.fields)) console.log(`  ${k} = ${v}`);
  console.log(problems.length ? '\nPROBLEMS:\n  ' + problems.join('\n  ') : '\nwell-formed');
  process.exitCode = problems.length ? 1 : 0;
}
