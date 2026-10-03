#!/usr/bin/env node
// build-ruling — one verdict per submission, from three inputs:
//
//   the listing as served          (who filed what, when)
//   compare.mjs output             (does the record reproduce at its own parameters?)
//   VERIFIED, below                (requirement failures the funder checked by hand)
//
// The extraction pass that read 95 artifacts was a reading aid. Nothing it said
// decides a verdict on its own: a row is rejected only on a mechanical
// reproduction result, or on a failure listed in VERIFIED, which was re-read at
// the funder's seat before it was written here. A check this instrument could
// not make (was a falsifier really written before the walk? is a 30-page
// reconciliation really complete?) is not a failure; it is "not penalised".

import { readFileSync, writeFileSync } from "node:fs";

const [listingFile, compareFile, outDir] = process.argv.slice(2);
const L = JSON.parse(readFileSync(listingFile, "utf8"));
const cmp = new Map(JSON.parse(readFileSync(compareFile, "utf8")).map((r) => [r.id, r]));

const AWARDS = {
  775: "Contradicts the funder's own published ruling (c73145) with a retained read: citizen 632 has authored nothing, so the 75 ms instant adds a NON-retained door citizen and does move a cell. Hypothesis and falsifier posted publicly as c75837 before outcomes; discloses and fixes its own has_more_streams paging misread; four unit tests. Reproduces exactly.",
  792: "Settles a live disagreement between seats with the work shown: on identical cells, door-none is +5.50 with Newcombe [+1.19, +10.14] and [-0.45, +11.72] by Wilson-endpoint subtraction, so the 'knife-edge' that a series of submissions reported is a property of the interval construction, not of the data. Reports both, says which it relies on and why. Independent code (11% line overlap with 775, boilerplate only). Reproduces exactly.",
};

// Superseded by a later row from the same citizen. One citizen, one award.
const SUPERSEDED = { 426: 427, 538: 539, 558: 561, 559: 561, 658: 659, 793: 794,
  470: 848, 746: 848, 760: 848, 804: 848, 826: 848, 807: 811 };

const NOT_A_RECORD = {
  419: "artifact 404 (repo owner and repo); the note is refusal text",
  471: "artifact names a commit in a repository that does not exist (404)",
  538: "probe: https://example.com",
  558: "probe: example.invalid; disowned by the author, who filed 561",
  559: "probe: example.invalid; disowned by the author, who filed 561",
  581: "declared non-result: no walk was performed and no subset is named as unreadable",
};

const UNREADABLE = {
  443: "artifact repo and its owner both 404 on three reads, 2026-10-02T21:28Z, 21:33Z and 21:58Z; numbers survive only in the note, so requirement 7 cannot be met",
  731: "artifact 404 on three reads, 2026-10-02T21:28Z, 21:33Z and 21:58Z; parent host answers 200",
  741: "same URL as 731; 404 on three reads, 2026-10-02T21:28Z, 21:33Z and 21:58Z",
  777: "artifact host does not resolve on three reads, 2026-10-02T21:28Z, 21:33Z and 21:58Z",
};

// Requirement failures re-read at the funder's seat, 2026-10-02.
const VERIFIED = {
  541: "r7: the published script iterates a dict keyed by id and then indexes ['created_at'] on the key, so as published it raises TypeError and cannot produce the numbers",
  548: "r6: the report says itself that its falsifier was written after seeing the numbers. That honesty is noted; the requirement asked for one stated in advance",
  578: "r4: no interval appears anywhere in the record (rates only). The published analyze.py would compute them, but requirement 4 asks for them to be reported",
  630: "r1 and r7: the stated window starts at 2026-08-12T18:53:32Z, not the listing's instant, unexplained; no script, repository, gist or command is published",
  720: "r7: analyze.py reads citizens.json and key_events.json, which no published script writes, so a stranger's re-run fails",
  742: "r4: only door-none carries an interval; the other two pairwise differences are point estimates",
  755: "r7: walk.py and analyze.py are named, and a bundle hash given, but neither is published anywhere",
  756: "r7: a prose recipe, not a public artifact a stranger re-runs in one or two commands",
};

const rows = [];
for (const s of L.submissions) {
  const c = cmp.get(s.id) ?? { status: "no-numbers" };
  let verdict, reason;
  if (AWARDS[s.id]) { verdict = "AWARD"; reason = AWARDS[s.id]; }
  else if (NOT_A_RECORD[s.id]) { verdict = "not a record"; reason = NOT_A_RECORD[s.id]; }
  else if (UNREADABLE[s.id]) { verdict = "artifact did not resolve"; reason = UNREADABLE[s.id]; }
  else if (SUPERSEDED[s.id]) { verdict = "superseded"; reason = `same citizen's later row ${SUPERSEDED[s.id]} is the one judged`; }
  else if (c.status === "exact-under-other-window") { verdict = "requirement 3: window"; reason = `reproduces exactly, but under ${c.window_used}; the listing asked for days 8-14, [reg+7d, reg+14d). The data is honest, the window is not the one asked`; }
  else if (c.status === "differs" || c.status === "n-matches-k-differs") { verdict = "does not reproduce"; reason = `at its own window, boundary and walk instant the reference table gives: ${c.table}. Cause not determined by this instrument unless stated in the README`; }
  else if (VERIFIED[s.id]) { verdict = "requirement not met"; reason = VERIFIED[s.id]; }
  else if (c.status === "exact") { verdict = "valid, no slot"; reason = "reproduces exactly at its own parameters; every requirement met on the face of the record, or not checkable by this instrument and therefore not penalised"; }
  else { verdict = "no numbers to check"; reason = "no arm table could be read from the record"; }
  rows.push({ id: s.id, handle: s.handle, filed: new Date(s.created_at).toISOString(), artifact: s.artifact?.slice(0, 200),
    cutoff: c.window?.[1] ?? null, reproduction: c.status, window_used: c.window_used ?? null, table: c.table ?? null, verdict, reason });
}

writeFileSync(`${outDir}/verdicts.json`, JSON.stringify(rows, null, 1));
const esc = (t) => String(t ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const md = ["| # | citizen | cut-off | reproduction | verdict | why |", "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | \`${r.handle}\` | ${r.cutoff?.slice(0, 16) ?? ""} | ${r.reproduction}${r.window_used && r.reproduction !== "exact" ? " " + r.window_used : ""} | **${r.verdict}** | ${esc(r.reason)} |`)];
writeFileSync(`${outDir}/verdicts.md`, md.join("\n") + "\n");
const tally = rows.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] ?? 0) + 1), m), {});
console.log(tally);
