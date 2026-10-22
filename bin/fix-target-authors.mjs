// Rebuild the authors column of a listing-38 target sheet from the resolved read.
//
// @hypatia-clavius's audit (c105457 on #6392) found that post #6392's claim,
// "authors come from the source, never from the submission citing it", held for
// 39 of 56 rows. The other 17 printed the submitter's string, and one of them was
// wrong: arxiv:2609.04135 named a "Samuel K. Moore" who is not on the paper. Our
// own retained read (sources-resolved.json, fetched 2026-09-21T17:20:20Z) had the
// right name, `Ndichu, Samuel`. The resolver was right and the sheet ignored it.
//
// The same audit found two more builder defects, fixed here too:
// - 13 `affiliations` values were cut at exactly 300 characters, mid-JSON. Those
//   came from the submitters' artifacts, so the only honest recovery is a re-read
//   of the artifact, accepted ONLY where the published 300-character value is an
//   exact prefix of the re-read field (affiliations-refetch.json). Where it is not,
//   the row says it is truncated instead of having a guess filled in.
// - Two titles kept HTML entities (`&#39;`, `&amp;`). `title_as_served` keeps
//   them, because that is the retained reading; `title` is unescaped.
//
// `authors_as_submitted` keeps what the submitter wrote, so nothing is lost.
import fs from 'node:fs';

const dir = process.argv[2] || 'rulings/listing-38';
const rows = JSON.parse(fs.readFileSync(`${dir}/targets.json`, 'utf8'));
const resolved = JSON.parse(fs.readFileSync(`${dir}/sources-resolved.json`, 'utf8'));
const refetch = JSON.parse(fs.readFileSync(`${dir}/affiliations-refetch.json`, 'utf8'));

// arXiv serves "Last, First; Last, First". The DOI resolvers already serve "First Last".
export const sheetAuthors = (key, served) => !key.startsWith('arxiv:') ? served
  : served.split('; ').map((n) => {
    const i = n.indexOf(', ');
    return i < 0 ? n : `${n.slice(i + 2)} ${n.slice(0, i)}`;
  }).join('; ');

const unescape = (s) => s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const md = fs.readFileSync(`${dir}/target-list.md`, 'utf8').split('\n');
const mdLine = (title, label) => {
  const h = md.indexOf(`### ${title}`);
  if (h < 0) throw new Error(`no heading for ${title}`);
  for (let i = h + 1; i < md.length && !md[i].startsWith('### '); i++) {
    if (md[i].startsWith(`- **${label}** `)) return i;
  }
  return -1;
};

let authorsChanged = 0, affRecovered = 0, affTruncated = 0, titles = 0;
for (const r of rows) {
  const read = resolved[r.work_key];
  if (!read || !read.authors) throw new Error(`no resolved authors for ${r.work_key}`);
  const heading = r.title;
  const authors = sheetAuthors(r.work_key, read.authors);
  r.authors_as_submitted ??= r.authors;
  if (authors !== r.authors) {
    authorsChanged++;
    const i = mdLine(heading, 'authors');
    md[i] = `- **authors** ${authors}`;
  }
  r.authors = authors;

  if (r.affiliations.length === 300) {
    const got = refetch.find((x) => x.sub === r.submission);
    const i = mdLine(heading, 'affiliations');
    if (got && got.recovered && got.full.startsWith(r.affiliations)) {
      r.affiliations = got.full;
      r.affiliations_refetched_at = got.fetched_at;
      md[i] = `- **affiliations** ${got.full}`;
      affRecovered++;
    } else {
      r.affiliations_truncated = true;
      md[i] = `- **affiliations** ${r.affiliations} … *(cut at 300 characters by the sheet builder; the artifact could not be re-read to an exact match)*`;
      affTruncated++;
    }
  }

  const clean = unescape(r.title);
  if (clean !== r.title) {
    r.title_as_served = r.title;
    r.title = clean;
    md[md.indexOf(`### ${heading}`)] = `### ${clean}`;
    titles++;
  }
}

fs.writeFileSync(`${dir}/targets.json`, JSON.stringify(rows, null, 1));
fs.writeFileSync(`${dir}/target-list.md`, md.join('\n'));
console.log(`authors rebuilt from the resolved read: ${authorsChanged} rows changed, ${rows.length - authorsChanged} already matched`);
console.log(`affiliations: ${affRecovered} recovered by exact-prefix re-read, ${affTruncated} marked truncated`);
console.log(`titles unescaped: ${titles}`);
