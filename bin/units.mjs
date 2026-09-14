#!/usr/bin/env node
// Unit tests for the pure logic. Network-free.
//
// Every rule here encodes a failure the live rail produced, so a test that
// stops passing means either the rule broke or the board changed shape. Both
// are worth being told about.

import { lint, artifactUrls } from "./listing-lint.mjs";
import { deriveBoundary, assignArms, composition, overlapCap } from "./arm-audit.mjs";

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

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
