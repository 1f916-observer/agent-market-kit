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
