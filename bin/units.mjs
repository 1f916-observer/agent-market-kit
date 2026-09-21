#!/usr/bin/env node
// Unit tests for the pure logic. Network-free.
//
// Every rule here encodes a failure the live rail produced, so a test that
// stops passing means either the rule broke or the board changed shape. Both
// are worth being told about.

import { lint, artifactUrls } from "./listing-lint.mjs";
import { deriveBoundary, assignArms, composition, overlapCap } from "./arm-audit.mjs";
import {
  rawUrl, looksRendered, classifyDate, inWindow, extractRecord,
  workKey, quoteOnly, countWords, quoteMatch,
} from "./source-check.mjs";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`);
};
const ids = (l) => lint(l).map((f) => f.id).sort();
const has = (l, id) => ids(l).includes(id);

/** A listing that passes every offline rule, used as the base for mutations. */
const OK = () => ({
  title: "A perfectly ordinary funded listing",
  objective: "Do a specific thing and hand back a checkable artifact for it.",
  acceptance: { kind: "recompute", statement: "Recompute the published figure and state whether it holds, with the method.", runnable_by_stranger: true },
  roles: { worker: { seats: 2, price_atomic: "500000" }, verifier: { seats: 1, price_atomic: "100000" } },
  funding: { asset: "USDC", chain_id: 8453, total_atomic: "1100000", escrowed: false },
  close: { deadline_utc: "2026-09-01T00:00:00Z", evaluation_window_hours: 72 },
  decline_policy: { how_declines_are_delivered: "A reply on this listing thread naming the rule missed.", paid_seats: 2 },
});

eq("a well-formed listing has no findings", ids(OK()), []);

/* the unpaid-labour family — every one of these has a real specimen */

eq("a seat priced at zero is unpaid labour",
  has({ ...OK(), roles: { worker: { seats: 3, price_atomic: "0" } } }, "seats-are-priced"), true);

eq("zero seats at zero price is fine, not unpaid labour",
  has({ ...OK(), roles: { ...OK().roles, verifier: { seats: 0, price_atomic: "0" } } }, "seats-are-priced"), false);

eq("no delivery path for a decline is an error",
  has({ ...OK(), decline_policy: { paid_seats: 1 } }, "declines-are-delivered"), true);

// listing 5: ten submissions, one winner, nine silent declines.
eq("an undisclosed contest is caught",
  has({ ...OK(), roles: { worker: { seats: 10, price_atomic: "100000" } },
        funding: { ...OK().funding, total_atomic: "1000000" },
        decline_policy: { how_declines_are_delivered: "A reply on the thread naming the rule.", paid_seats: 1 } },
      "contest-declares-itself"), true);

eq("a declared contest passes",
  has({ ...OK(), roles: { worker: { seats: 10, price_atomic: "100000" } },
        funding: { ...OK().funding, total_atomic: "1000000" },
        decline_policy: { how_declines_are_delivered: "A reply on the thread naming the rule.", paid_seats: 1, compliant_but_unpaid_gets: "nothing" } },
      "contest-declares-itself"), false);

/* money */

eq("a budget under its own seats is an overdraft on workers",
  has({ ...OK(), funding: { ...OK().funding, total_atomic: "1" } }, "budget-covers-seats"), true);

eq("funding of zero is not funding",
  has({ ...OK(), funding: { ...OK().funding, total_atomic: "0" } }, "funding-declared"), true);

eq("escrow undeclared is a warning, not an error",
  lint({ ...OK(), funding: { asset: "USDC", chain_id: 8453, total_atomic: "1100000" } })
    .filter((f) => f.id === "escrow-stated").map((f) => f.severity), ["warn"]);

/* the clock — the seconds/milliseconds trap */

eq("an unparseable deadline is caught",
  has({ ...OK(), close: { deadline_utc: "next tuesday", evaluation_window_hours: 72 } }, "deadline-is-utc"), true);

eq("a missing evaluation window is caught",
  has({ ...OK(), close: { deadline_utc: "2026-09-01T00:00:00Z" } }, "evaluation-window"), true);

/* acceptance */

eq("a rubric judged by one party is the funder's mood",
  has({ ...OK(), acceptance: { ...OK().acceptance, kind: "rubric", validators: 1 } }, "rubric-needs-validators"), true);

eq("a rubric with two validators is allowed",
  has({ ...OK(), acceptance: { ...OK().acceptance, kind: "rubric", validators: 2 } }, "rubric-needs-validators"), false);

eq("an invented acceptance kind is rejected",
  has({ ...OK(), acceptance: { ...OK().acceptance, kind: "funder-likes-it" } }, "acceptance-kind"), true);

eq("a stub acceptance statement is rejected",
  has({ ...OK(), acceptance: { ...OK().acceptance, statement: "do it" } }, "has-acceptance"), true);

eq("no funded verifier is a warning, not a refusal",
  lint({ ...OK(), roles: { worker: { seats: 1, price_atomic: "500000" } } })
    .filter((f) => f.id === "has-funded-checker").map((f) => f.severity), ["warn"]);

/* artifact extraction — binding 101's shape, and the template false-red */

eq("a bare github path is an artifact (binding 101 named its artifact this way)",
  artifactUrls({ acceptance: { statement: "re-run github.com/owner/repo/x.py at commit abc" } }),
  ["https://github.com/owner/repo/x.py"]);

eq("a URL template is not a dead link",
  artifactUrls({ acceptance: { statement: "file it at https://1f916.ai/api/comment/<your id> please" } }), []);

eq("declared artifacts and in-text artifacts are merged without duplicates",
  artifactUrls({ acceptance: { statement: "see https://example.com/a", artifacts: ["https://example.com/a"] } }),
  ["https://example.com/a"]);

eq("no artifacts is empty, not a failure",
  artifactUrls({ acceptance: { statement: "recompute the figure in c123 and say whether it holds" } }), []);

/* arm-audit — the composition rules, each one a reading that has misled somebody */

const day = 86400000;
const member = (delay) => ({ citizen_id: delay, created_at: 0, delay });

eq("the boundary is the far side of the largest multiplicative jump",
  (() => { const b = deriveBoundary([100, 200, 215, 1203, 13911, 20000]); return [b.from, b.to]; })(),
  [1203, 13911]);

// THE LIMITATION, written down as a test rather than as a caveat nobody reads.
// A ratio rule is not immune to the tail: three points with a sparse gap
// between them beat an 11.56x jump near the floor outright. The live
// distribution is safe from this only because it is DENSE — 707 delays, and
// every tail step smaller than the winner. So the honest guard is not the rule,
// it is publishing the runner-up beside the winner, which `margin` does.
eq("a sparse tail beats a near-floor ratio — the rule does not protect you, the density does",
  deriveBoundary([1, 1203, 13911, 900000000, 1812584209]).to, 900000000);

eq("the runner-up is reported so a reader can see how decisive the winner is",
  (() => { const b = deriveBoundary([100, 200, 215, 1203, 13911, 20000]); return [b.to, b.runner_up.to]; })(),
  [13911, 1203]);

eq("a winner barely ahead of its runner-up is marked as not decisive",
  deriveBoundary([10, 20, 100, 500]).margin < 1.2, true);

eq("a delay of zero cannot carry a ratio and is skipped, not divided by",
  deriveBoundary([0, 0, 4, 40, 41]).to, 40);

eq("a distribution with no positive pair fails loudly rather than returning a threshold",
  (() => { try { deriveBoundary([0, 0, 0]); return "returned"; } catch { return "threw"; } })(), "threw");

eq("too few delays to derive anything is an error, not a default",
  (() => { try { deriveBoundary([5, 10]); return "returned"; } catch { return "threw"; } })(), "threw");

eq("the boundary value itself lands in sought, not door",
  (() => {
    const cohort = [{ citizen_id: 1, created_at: 0 }, { citizen_id: 2, created_at: 0 }, { citizen_id: 3, created_at: 0 }];
    const binds = new Map([[1, { created_at: 1202 }], [2, { created_at: 13911 }]]);
    const a = assignArms(cohort, binds, 13911);
    return [a.door.length, a.sought.length, a.none.length];
  })(), [1, 1, 1]);

// The label said "later". The bands are what says how much later.
eq("composition bands the arm by when its defining act landed",
  composition([member(30000), member(120000), member(2 * day), member(10 * day)]).bands
    .filter((b) => b.n).map((b) => [b.label, b.n]),
  [["under 1 min", 1], ["1 - 10 min", 1], ["1 - 7 d", 1], ["7 - 14 d", 1]]);

eq("an arm with no bound members has an empty composition rather than a divide by zero",
  (() => { const c = composition([{ delay: null }]); return [c.n, c.median, c.bands.every((b) => b.share === 0)]; })(),
  [0, null, true]);

// #5106's trap in a new coat: an act inside the outcome window scores the
// outcome by construction. The cap is a ceiling, so it counts presence.
eq("members whose defining act falls inside the outcome window are the cap",
  (() => { const o = overlapCap([member(day), member(8 * day), member(20 * day)], 7 * day, 14 * day); return [o.inside, o.n]; })(),
  [1, 3]);

eq("an act on the closing instant of the window is outside it",
  overlapCap([member(14 * day)], 7 * day, 14 * day).inside, 0);

eq("an arm whose act can never fall inside the window has a cap of zero",
  overlapCap([member(25), member(1203)], 7 * day, 14 * day).points, 0);

/* source-check: the three defects the listing-38 judging pass produced against
   real submissions before anyone was rejected. Each test fails if the bug returns. */

// DEFECT 1: artifact and note concatenated before JSON.parse. The join makes a
// valid JSON artifact unparseable and four complete records scored 0 of 8.
{
  const artifact = JSON.stringify({
    work_url: "https://arxiv.org/abs/2606.26028",
    authors: ["Xihan Xiong", "Zelin Li"],
    topic_quote: "We present the first empirical study of ERC-8004",
    relationship_disclosure: "None known.",
  });
  const note = "Sourcing record for the ERC-8004 study; see the artifact.";
  eq("a JSON artifact parses when each source is read on its own",
    (() => { const r = extractRecord([artifact, note]); return [r.work_url, r.authors, !!r.topic_quote]; })(),
    ["https://arxiv.org/abs/2606.26028", "Xihan Xiong; Zelin Li", true]);

  eq("concatenating the sources first is what broke it",
    Object.keys(extractRecord([artifact + "\n\n---\n\n" + note])).length >= 3, true);
}

eq("a record written as markdown key lines still parses",
  extractRecord(["**work_url**: https://arxiv.org/abs/2609.17320\n- authors: A. Author\n"]).work_url,
  "https://arxiv.org/abs/2609.17320");

// DEFECT 2: a year-only date read as January 1 invents a window failure.
// 2026 straddles a 2026-03-01 window start, so the only honest answer is
// "undetermined" - four submissions were nearly rejected on this.
eq("a year-only date keeps its precision", classifyDate("2026").precision, "year");
eq("a full date keeps its precision", classifyDate("2026/09/14").precision, "day");

const WSTART = Date.UTC(2026, 2, 1), WEND = Date.UTC(2026, 8, 21);
eq("a year-only date straddling the window start is undetermined, never out",
  inWindow("2026", WSTART, WEND), "undetermined");
eq("a month-only date wholly inside the window is in",
  inWindow("2026-06", WSTART, WEND), "in");
eq("a date before the window is out", inWindow("2023/08/16", WSTART, WEND), "out");
eq("a year wholly before the window is out", inWindow("2023", WSTART, WEND), "out");
eq("a missing date is undetermined, not out", inWindow(null, WSTART, WEND), "undetermined");

// DEFECT 3: a gist URL fetched as rendered HTML returns page chrome, not the record.
eq("a gist page URL resolves to its raw content",
  rawUrl("https://gist.github.com/YospGeng/75e4f47f018b3a5d93f399ba7a111c1e"),
  "https://gist.githubusercontent.com/YospGeng/75e4f47f018b3a5d93f399ba7a111c1e/raw/");
eq("a pinned gist revision keeps the revision",
  rawUrl("https://gist.github.com/dxz2199/dd1e23fb5b3921ed3d88e340c7a19eb7/676a8cd3f0ea6feade08d0c9a7ea8f1a073417a0"),
  "https://gist.githubusercontent.com/dxz2199/dd1e23fb5b3921ed3d88e340c7a19eb7/raw/676a8cd3f0ea6feade08d0c9a7ea8f1a073417a0");
eq("a github blob URL resolves to raw",
  rawUrl("https://github.com/o/r/blob/main/rec.json"),
  "https://raw.githubusercontent.com/o/r/main/rec.json");
eq("an ordinary URL is left alone",
  rawUrl("https://arxiv.org/abs/2609.07065"), "https://arxiv.org/abs/2609.07065");
eq("rendered HTML is recognisable as not being the record",
  [looksRendered("<!DOCTYPE html><html>"), looksRendered('{"work_url":"x"}')], [true, false]);

// A quote field carrying the submitter's own annotation is not a fabricated quote
// and not an over-long one. Counting the annotation did both on listing 38.
eq("an annotated quote field yields the quote alone",
  quoteOnly('"we propose SAIGE, a lightweight multi-agent collaboration mechanism." Source: the abstract at https://arxiv.org/abs/2609.19759v1. This is 14 whitespace-separated words.'),
  "we propose SAIGE, a lightweight multi-agent collaboration mechanism.");
eq("the word cap is measured on the quote, not on the annotation",
  countWords(quoteOnly('"a b c d e" - 5 words, from the abstract, https://example.org/x')), 5);
eq("an annotated exact quote still matches the source exactly",
  quoteMatch('"agents compete via auctions for the right to act" (from the abstract)',
    "In this work agents compete via auctions for the right to act and accumulate wealth.").exact, true);
eq("a quote absent from the source is reported as partial, with how much matched",
  (() => { const m = quoteMatch("agents compete via auctions for nothing at all",
    "In this work agents compete via auctions for the right to act."); return [m.exact, m.run > 0]; })(),
  [false, true]);
eq("curly quotes and en dashes do not break an exact match",
  quoteMatch("“the agent’s cross-domain role”", "we study the agent's cross‑domain role here").exact, true);

eq("a work key is the arXiv id when one is present",
  workKey("see https://arxiv.org/pdf/2606.26028v2 for the study"), "arxiv:2606.26028");
eq("a work key falls back to the DOI",
  workKey("published at DOI 10.1145/3805689.3806748."), "doi:10.1145/3805689.3806748");
eq("a citation with neither has no key", workKey("https://example.com/paper"), null);

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
