#!/usr/bin/env node
// fetch-artifacts — retain every listing-39 artifact as served, with its
// SHA-256, byte length and fetch time, so the ruling can be replayed rather
// than trusted. Lessons carried from listing 38: a gist page is ~118 KB of
// chrome, so gists are read through the API (ALL files, not just the first);
// a 404 read once is a reading, not a verdict, so a failure is retried spaced
// and the parent is probed.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const [listingFile, outDir] = process.argv.slice(2);
const L = JSON.parse(readFileSync(listingFile, "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = (path) => execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 << 20 });

function firstUrl(s) { const m = String(s).match(/https?:\/\/[^\s)<>"'`\]]+/); return m ? m[0].replace(/[.,;]+$/, "") : null; }

async function fetchBytes(url) {
  let last;
  for (const wait of [0, 4000, 15000]) {
    await sleep(wait);
    try {
      const r = await fetch(url, { redirect: "follow", headers: { accept: "text/plain, application/json, text/markdown, */*" } });
      const b = Buffer.from(await r.arrayBuffer());
      last = { status: r.status, type: r.headers.get("content-type"), bytes: b };
      if (r.ok) return last;
    } catch (e) { last = { status: "ERR " + e.message, bytes: Buffer.alloc(0) }; }
  }
  return last;
}

const index = [];
for (const s of L.submissions) {
  const dir = `${outDir}/${s.id}`; mkdirSync(dir, { recursive: true });
  const raw = s.artifact ?? "";
  const url = /^https?:\/\//.test(raw.trim()) ? raw.trim().split(/\s/)[0] : firstUrl(raw);
  const rec = { id: s.id, handle: s.handle, artifact_field: raw.slice(0, 300), url, fetched_at: new Date().toISOString(), files: [] };
  writeFileSync(`${dir}/_submission.json`, JSON.stringify(s, null, 2));
  const keep = (name, bytes, meta = {}) => { writeFileSync(`${dir}/${name.replace(/[^\w.-]/g, "_")}`, bytes); rec.files.push({ name, bytes: bytes.length, sha256: sha(bytes), ...meta }); };
  try {
    let m;
    if (!url) rec.kind = "inline-text-only";
    else if ((m = url.match(/gist\.github(?:usercontent)?\.com\/[^/]+\/([0-9a-f]{20,})(?:\/(?:raw\/)?([0-9a-f]{7,40}))?/i))) {
      rec.kind = "gist";
      const g = JSON.parse(gh(`gists/${m[1]}${m[2] ? "/" + m[2] : ""}`));
      rec.gist_revision = g.history?.[0]?.version ?? m[2] ?? null;
      for (const f of Object.values(g.files)) {
        let content = f.content;
        if (f.truncated && f.raw_url) content = (await fetchBytes(f.raw_url)).bytes.toString("utf8");
        keep(f.filename, Buffer.from(content ?? ""), { raw_url: f.raw_url });
      }
    } else if ((m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/(tree|blob|commit)\/([^/]+)(\/[^#?]*)?)?/))) {
      rec.kind = "github"; rec.repo = `${m[1]}/${m[2].replace(/\.git$/, "")}`; rec.ref = m[4] ?? null; rec.path = m[5] ?? null;
      const repo = JSON.parse(gh(`repos/${rec.repo}`)); rec.default_branch = repo.default_branch;
      const ref = m[3] === "blob" || m[3] === "tree" ? m[4] : (m[3] === "commit" ? m[4] : repo.default_branch);
      rec.resolved_ref = ref;
      const tree = JSON.parse(gh(`repos/${rec.repo}/git/trees/${ref}?recursive=1`));
      keep("_tree.json", Buffer.from(JSON.stringify(tree.tree.map((t) => [t.type, t.path, t.size ?? null]))));
      const pfx = (rec.path ?? "").replace(/^\//, "");
      const wanted = tree.tree.filter((t) => t.type === "blob" && (!pfx || t.path.startsWith(pfx)) && /\.(md|txt|json|py|mjs|js|ts|csv|sh)$/i.test(t.path) && (t.size ?? 0) < 2_000_000).slice(0, 40);
      for (const t of wanted) {
        const b = await fetchBytes(`https://raw.githubusercontent.com/${rec.repo}/${ref}/${t.path}`);
        keep(t.path.replace(/\//g, "__"), b.bytes, { status: b.status });
      }
    } else if ((m = url.match(/1f916\.ai\/(?:api\/)?(?:post|p)\/(\d+)/))) {
      rec.kind = "board-post"; const b = await fetchBytes(`https://1f916.ai/api/post/${m[1]}`); keep(`post-${m[1]}.json`, b.bytes, { status: b.status });
    } else if ((m = url.match(/1f916\.ai\/api\/comment\/(\d+)/))) {
      rec.kind = "board-comment"; const b = await fetchBytes(`https://1f916.ai/api/comment/${m[1]}`); keep(`comment-${m[1]}.json`, b.bytes, { status: b.status });
    } else {
      rec.kind = "url";
      let u = url;
      if (/^https:\/\/dpaste\.com\/[A-Z0-9]+$/.test(u)) u += ".txt";
      const b = await fetchBytes(u); keep("artifact", b.bytes, { status: b.status, type: b.type, fetched_url: u });
    }
  } catch (e) { rec.error = String(e.message).slice(0, 300); }
  // Bare "post 5987" style references on the board.
  if (!url && (m2 = raw.match(/post\s+#?(\d{3,5})/i))) { const b = await fetchBytes(`https://1f916.ai/api/post/${m2[1]}`); rec.kind = "board-post-bare"; keep(`post-${m2[1]}.json`, b.bytes, { status: b.status }); }
  index.push(rec);
  console.error(s.id, rec.kind, rec.error ?? rec.files.map((f) => f.status ?? "").join(","), rec.files.length);
  await sleep(600);
}
var m2;
writeFileSync(`${outDir}/_index.json`, JSON.stringify(index, null, 2));
