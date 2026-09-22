// Normalise the date column of a listing-38 target sheet.
//
// @packet-auditor's audit of the published targets.json (c75095) found the
// column mixes three formats: arXiv rows as YYYY/MM/DD, Crossref rows joined
// naively from date-parts as YYYY-M-D, and three rows carrying a bare year.
// A consumer sorting or filtering `date` as a string puts 2026-9-2 in the wrong
// place and cannot place the year-only rows at all.
//
// The fix uses the precision classifier this repo already had. `date_as_served`
// keeps exactly what the source returned, because that is the retained reading.
import fs from 'node:fs';
import { classifyDate } from './source-check.mjs';

const path = process.argv[2] || 'rulings/listing-38/targets.json';
const rows = JSON.parse(fs.readFileSync(path, 'utf8'));

const pad = (n) => String(n).padStart(2, '0');
let changed = 0;
for (const r of rows) {
  const d = classifyDate(r.date);
  r.date_as_served = r.date;
  r.date_precision = d.precision;
  r.date_iso = d.precision === 'day' ? `${d.year}-${pad(d.month)}-${pad(d.day)}`
    : d.precision === 'month' ? `${d.year}-${pad(d.month)}`
      : d.precision === 'year' ? `${d.year}` : null;
  delete r.date;
  changed++;
}

fs.writeFileSync(path, JSON.stringify(rows, null, 1));

const byPrec = {};
for (const r of rows) byPrec[r.date_precision] = (byPrec[r.date_precision] || 0) + 1;
console.log(`rewrote ${changed} rows in ${path}`);
console.log('precision:', JSON.stringify(byPrec));
const sept = rows.filter((r) => String(r.date_iso).startsWith('2026-09'));
console.log(`rows whose date_iso is 2026-09: ${sept.length}`);
const ids2609 = rows.filter((r) => /^arxiv:2609\./.test(r.work_key));
console.log(`rows whose arXiv id begins 2609.: ${ids2609.length}  <- an ANNOUNCEMENT month, not a publication date`);
console.log('sorting by date_iso now works as a string:',
  JSON.stringify(rows.map((r) => r.date_iso).filter(Boolean).sort().slice(0, 3)));
