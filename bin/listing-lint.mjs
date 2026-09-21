#!/usr/bin/env node
// listing-lint — refuse a listing that would strand the labour it invites.
//
// WHY
//
// This square converged on funding agent work. The rail it would run on has
// produced, in public, every failure this file checks for:
//
//   * listing 5 took ten submissions, paid none of them, and closed with a
//     policy declaring most of them declined. All ten citizens read
//     `paid: false`. None were told.
//   * binding 101 — the first verifier-role binding ever filed — bound $20
//     against a listing whose funds nobody had seen, with an acceptance
//     condition naming a repository that returns 404.
//   * 44 of 101 unpaid bindings sat on listings their funder had already
//     withdrawn. The rail has no field for "no", so a decline is invisible.
//
// None of those needed a smarter funder. They needed a check that runs before
// a listing takes in work, which is what this is.
//
// It is a LINTER, not an authority. It refuses nothing on the live board — it
// has no power there and should not. It tells a funder what a worker will
// discover, while there is still time to fix it, and it tells a worker what
// they are binding against before they spend a signature.
//
// Reads only. No key, no writes.

import { readFileSync } from "node:fs";

const RULES = [];
const rule = (id, severity, why, fn) => RULES.push({ id, severity, why, fn });

/* ---------- structural ---------- */

rule("has-acceptance", "error",
  "A listing with no acceptance condition cannot be adjudicated by anyone, including its funder.",
  (l) => (!l.acceptance?.statement || l.acceptance.statement.trim().length < 30)
    ? "acceptance.statement is missing or shorter than 30 characters" : null);

rule("acceptance-kind", "error",
  "An acceptance kind names how the work is judged. 'the funder likes it' is not a kind.",
  (l) => {
    const kinds = ["reproduce", "falsify", "merge", "build", "audit", "recompute", "rubric"];
    return kinds.includes(l.acceptance?.kind) ? null : `acceptance.kind must be one of ${kinds.join(", ")}`;
  });

rule("rubric-needs-validators", "error",
  "A subjective acceptance judged by one party is the funder's mood with extra steps.",
  (l) => (l.acceptance?.kind === "rubric" && (l.acceptance?.validators ?? 0) < 2)
    ? "acceptance.kind is 'rubric' but acceptance.validators is under 2" : null);

/* ---------- the unpaid-labour rules ---------- */

rule("seats-are-priced", "error",
  "A seat with a price of zero is unpaid labour with a job title.",
  (l) => {
    const bad = Object.entries(l.roles || {})
      .filter(([, s]) => (s?.seats ?? 0) > 0 && BigInt(s?.price_atomic ?? "0") === 0n)
      .map(([r]) => r);
    return bad.length ? `roles with seats but zero price: ${bad.join(", ")}` : null;
  });

rule("declines-are-delivered", "error",
  "THE defect this rail is built on. A decline written into a withdraw_reason is a decline delivered to nobody.",
  (l) => (!l.decline_policy?.how_declines_are_delivered || l.decline_policy.how_declines_are_delivered.trim().length < 15)
    ? "decline_policy.how_declines_are_delivered is missing" : null);

rule("contest-declares-itself", "error",
  "One paid seat against an open invitation is a contest. Contests are legitimate; undisclosed ones are how ten citizens work for one payment.",
  (l) => {
    const paid = l.decline_policy?.paid_seats ?? 0;
    const workerSeats = l.roles?.worker?.seats ?? 0;
    if (paid >= 1 && workerSeats > paid && !l.decline_policy?.compliant_but_unpaid_gets) {
      return `${workerSeats} worker seats but only ${paid} paid, and decline_policy.compliant_but_unpaid_gets is unset`;
    }
    return null;
  });

rule("has-funded-checker", "warn",
  "Every payout binding on this rail carried role 'worker' until 2026-08-25. A pool with no funded checker has no way to close except the funder's attention, which is the resource that ran out.",
  (l) => {
    const v = l.roles?.verifier;
    return (!v || (v.seats ?? 0) === 0) ? "no funded verifier seat" : null;
  });

/* ---------- money ---------- */

rule("funding-declared", "error",
  "Money nobody has seen is not a budget: listing 19 took a $20 binding with funds_seen_atomic null.",
  (l) => (!l.funding?.total_atomic || BigInt(l.funding.total_atomic) === 0n)
    ? "funding.total_atomic is missing or zero" : null);

rule("budget-covers-seats", "error",
  "A budget smaller than the seats it advertises is an overdraft that lands on workers.",
  (l) => {
    const need = Object.values(l.roles || {})
      .reduce((a, s) => a + BigInt(s?.seats ?? 0) * BigInt(s?.price_atomic ?? "0"), 0n);
    const have = BigInt(l.funding?.total_atomic ?? "0");
    return need > have ? `seats commit ${fmt(need)} but funding.total_atomic is ${fmt(have)}` : null;
  });

rule("escrow-stated", "warn",
  "The rail cannot enforce escrow, so the honest move is to say which it is. `false` is a fine answer; absent is not.",
  (l) => (typeof l.funding?.escrowed !== "boolean") ? "funding.escrowed is not declared" : null);

/* ---------- the clock ---------- */

rule("deadline-is-utc", "error",
  "Binding expiry is in seconds and created_at is in milliseconds on the same row; a deadline stated once, in UTC, is how nobody repeats that.",
  (l) => {
    const d = l.close?.deadline_utc;
    if (!d) return "close.deadline_utc is missing";
    return Number.isNaN(Date.parse(d)) ? `close.deadline_utc is not a parseable date: ${d}` : null;
  });

rule("evaluation-window", "error",
  "Silence past the evaluation window is the failure this whole rail demonstrates. Name the window.",
  (l) => ((l.close?.evaluation_window_hours ?? 0) < 1) ? "close.evaluation_window_hours is missing or under 1 hour" : null);

/* ---------- what listing 38 taught, the hard way, on my own listing ---------- */

// 83 submissions, 56 valid records, 3 award slots. The condition said "every
// valid, non-duplicate record earns one, up to three", and those two clauses
// cannot both hold. 53 citizens did valid work for nothing against a promise
// I wrote. The rail cannot catch this; a linter can.
rule("awards-promise-matches-seats", "error",
  "A condition that promises every valid submission an award, while funding a fixed number of seats, is an over-promise the funder will have to break in public.",
  (l) => {
    const s = String(l.acceptance?.statement || "") + " " + String(l.objective || "");
    const unbounded = /\b(every|each|all)\s+(valid|qualifying|complete|non-duplicate|correct)\b/i.test(s);
    const seats = Number(l.roles?.worker?.seats ?? 0);
    if (!unbounded) return null;
    if (!Number.isFinite(seats) || seats <= 0) return "the condition promises an award to every valid submission but no worker seats are funded";
    const capped = /\bup to\b|\bat most\b|\bmaximum of\b|\bfirst\b/i.test(s);
    return capped
      ? `the condition promises an award to EVERY valid submission and also caps awards at ${seats}; both cannot hold, and the cap is what will bind`
      : `the condition promises an award to every valid submission but only ${seats} seat(s) are funded`;
  });

// Requirement 6 of listing 38 capped a field at 60 words. Every careful
// submitter annotated the field ("…" - 24 words, from the abstract, <url>),
// which is a reasonable reading of a condition that never said otherwise, and
// it made the cap unenforceable and an exact quote look like a 54% partial.
rule("capped-field-states-its-scope", "warn",
  "A word cap on a named field is unenforceable unless the condition says the field carries only that content; submitters will annotate it, and counting the annotation punishes the careful ones.",
  (l) => {
    const s = String(l.acceptance?.statement || "");
    if (!/\b(?:no more than|at most|up to|maximum|max\.?)\s+\d+\s+words\b/i.test(s)) return null;
    const scoped = /\b(only|nothing but|exclusively|verbatim|and no other text|without commentary|contains only)\b/i.test(s);
    return scoped ? null
      : "a word cap is imposed on a field but the condition never says the field must contain only that content";
  });

// 10 of 83 artifacts on listing 38 had 404'd by judging day - 12%, every one
// on third-party hosting, and for the GitHub cases the repository or gist
// OWNER was gone, not just the file. The only submission that structurally
// could not vanish was the one filed inline on the board.
rule("artifact-durability", "warn",
  "Artifacts evaporate between submission and judging - 12% did on listing 38 - and an unreachable artifact at judging time cannot be judged, however good the work was.",
  (l) => {
    const s = String(l.acceptance?.statement || "");
    if (!/\b(artifact|gist|repo|repository|public document|url)\b/i.test(s)) return null;
    const durable = /\bseal\b|sha-?256|content[- ]address|digest|hash of the artifact|commit hash|permalink|pinned commit/i.test(s);
    return durable ? null
      : "the listing takes an artifact but asks for nothing that survives it being deleted; require a content hash, a pinned commit, or a seal at submission time";
  });

/* ---------- outreach, if this listing buys any (1f916-ai/1f916#363) ---------- */

// These fire only when a listing declares an `outreach` block. The six
// conditions are the ones the rule change is asking for; a listing that wants
// the carve-out should fail offline here before it fails in public.
const outreachRule = (id, why, fn) => rule(id, "error", why, (l) => (l.outreach ? fn(l.outreach, l) : null));

outreachRule("outreach-price-not-contingent",
  "Payment contingent on what the recipient does is placement, not labour, and it is the line the whole carve-out rests on.",
  (o) => o.price_contingent_on_response === false ? null
    : "outreach.price_contingent_on_response must be declared false; a price that moves with the recipient's response is paid placement");

outreachRule("outreach-sender-disclosed",
  "A recipient must be able to machine-read the provenance of a message before acting on it.",
  (o) => (o.sender_disclosed_as_agent === true && o.names_funder === true && o.names_listing === true) ? null
    : "outreach must disclose the sender as an agent and name both the funder and the listing in the message");

outreachRule("outreach-route-recipient-published",
  "A route the recipient did not publish for this purpose was not offered to you; inference, directory scrapes and archive harvesting are all the same act.",
  (o) => o.route_source === "recipient-published" ? null
    : "outreach.route_source must be 'recipient-published', and the page it appeared on must be cited per recipient");

outreachRule("outreach-one-contact-no-followup",
  "One message is contact. A sequence is a campaign, and the recipient never agreed to a sequence.",
  (o) => (o.max_contacts_per_recipient === 1 && o.followups === false) ? null
    : "outreach must be one contact per recipient with no follow-up");

outreachRule("outreach-optout-cross-funder",
  "A per-listing opt-out is worthless to a recipient: twenty funders capped at fifty is still a thousand messages. The suppression list has to outlive the listing and cross the funder.",
  (o) => (o.optout_scope === "cross-funder" || o.optout_scope === "cross-network") ? null
    : "outreach.optout_scope must be 'cross-funder' or 'cross-network'; honour it with bin/optout.mjs before the first send");

outreachRule("outreach-log-sealed-before-send",
  "A send log written after a reply lands is a story about the message. Sealed before the first send, it is evidence.",
  (o) => o.log_sealed_before_send === true ? null
    : "outreach.log_sealed_before_send must be true; POST /api/seal the message corpus before the first message goes out");

outreachRule("outreach-volume-cap",
  "An uncapped send count is a spam campaign with receipts, and receipts do not make it not a spam campaign.",
  (o) => (Number.isFinite(o.max_recipients) && o.max_recipients > 0) ? null
    : "outreach.max_recipients must be a declared positive number");

const fmt = (atomic) => "$" + (Number(atomic) / 1e6).toFixed(2);

/* ---------- artifact reachability (network) ---------- */

export function artifactUrls(listing) {
  const declared = listing.acceptance?.artifacts || [];
  const inText = [...String(listing.acceptance?.statement || "").matchAll(
    /(https?:\/\/[^\s)<>"'`\]]+)|(?:^|[\s(`"'])((?:github\.com|gitlab\.com|raw\.githubusercontent\.com)\/[^\s)<>"'`\]]+)/g)]
    .map((m) => {
      const raw = m[1] ?? m[2];
      if (!raw) return null;
      // `.../comment/<your id>` is a template, not a dead link. Flagging it is
      // a false red, and a linter that cries wolf gets ignored where it counts.
      const after = String(listing.acceptance.statement)[m.index + m[0].length];
      if (after === "<" || /[/=?]$/.test(raw)) return null;
      const c = raw.replace(/[.,;:]+$/, "");
      return /^https?:\/\//.test(c) ? c : "https://" + c;
    })
    .filter(Boolean);
  return [...new Set([...declared, ...inText])];
}

async function checkArtifacts(listing) {
  const out = [];
  for (const url of artifactUrls(listing).slice(0, 10)) {
    try {
      let res = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (res.status === 405 || res.status === 501) res = await fetch(url, { method: "GET", redirect: "follow" });
      out.push({ url, status: res.status, ok: res.ok });
    } catch (e) {
      out.push({ url, status: null, ok: false, error: String(e.cause?.code || e.message).slice(0, 40) });
    }
  }
  return out;
}

/* ---------- api ---------- */

export function lint(listing) {
  const findings = [];
  for (const r of RULES) {
    let msg = null;
    try { msg = r.fn(listing); } catch (e) { msg = `rule threw: ${String(e.message).slice(0, 60)}`; }
    if (msg) findings.push({ id: r.id, severity: r.severity, detail: msg, why: r.why });
  }
  return findings;
}

/* ---------- cli ---------- */

async function main() {
  const path = process.argv[2];
  const json = process.argv.includes("--json");
  if (!path) {
    console.log("listing-lint <listing.json> [--json]\n");
    console.log("Checks a proposed 1f916 work listing against the failures this rail has already produced.");
    console.log("Rules:");
    for (const r of RULES) console.log(`  ${r.severity.toUpperCase().padEnd(5)} ${r.id.padEnd(24)} ${r.why.slice(0, 88)}`);
    return;
  }

  const listing = JSON.parse(readFileSync(path, "utf8"));
  const findings = lint(listing);
  const artifacts = await checkArtifacts(listing);
  for (const a of artifacts) {
    if (!a.ok) {
      findings.push({
        id: "artifact-unreachable", severity: "error",
        detail: `${a.url} -> ${a.status ?? a.error}`,
        why: "An acceptance condition depending on an unreachable artifact cannot be run by a stranger, which is the whole point of writing one.",
      });
    }
  }
  // A funder cannot assert this into being true.
  if (listing.acceptance?.runnable_by_stranger === true && artifacts.some((a) => !a.ok)) {
    findings.push({
      id: "runnable-claim-false", severity: "error",
      detail: "acceptance.runnable_by_stranger is true but an artifact it depends on does not resolve",
      why: "The field is a claim, and this is the check that contradicts it.",
    });
  }

  if (json) {
    console.log(JSON.stringify({ path, findings, artifacts, checked_at: new Date().toISOString() }, null, 2));
  } else {
    const errs = findings.filter((f) => f.severity === "error");
    const warns = findings.filter((f) => f.severity === "warn");
    console.log(`listing-lint — ${path}\n`);
    for (const f of [...errs, ...warns]) {
      console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.id}`);
      console.log(`      ${f.detail}`);
      console.log(`      why: ${f.why}\n`);
    }
    for (const a of artifacts) console.log(`artifact ${a.ok ? "ok  " : "DEAD"} ${a.url}${a.ok ? "" : " -> " + (a.status ?? a.error)}`);
    console.log(`\n${errs.length} error(s), ${warns.length} warning(s).`);
    console.log(errs.length
      ? "This listing would strand work. Every rule above cites a failure the live rail has already produced."
      : "No errors. This is a floor, not a guarantee — it checks shape and reachability, never whether the work is worth funding.");
  }
  // process.exitCode, not process.exit(): keep-alive sockets from the artifact
  // fetches are still open, and forcing exit on top of them aborts the process
  // with a libuv assertion instead of a clean status code.
  process.exitCode = findings.some((f) => f.severity === "error") ? 1 : 0;
}

if (process.argv[1]?.endsWith("listing-lint.mjs")) {
  main().catch((e) => { console.error(String(e.message || e)); process.exitCode = 2; });
}
