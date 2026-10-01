#!/usr/bin/env node
/**
 * Hit every endpoint on a running deployment and report what breaks.
 *
 *   BASE=https://… node tools/smoke-live.mjs
 *
 * Read-mostly: it sends a couple of chat turns because several bugs only
 * appear on a real turn, but it does not link accounts or mark memories wrong.
 */

const BASE = process.env.BASE ?? "http://localhost:8080";
const USER = process.env.SMOKE_USER ?? "smoke-" + Date.now();
let failed = 0;

const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

async function hit(path, { method = "GET", body, expect = 200 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html pages */ }
    return { status: res.status, json, text, ms: Date.now() - t0, ok: res.status === expect };
  } catch (err) {
    return { status: 0, json: null, text: "", ms: Date.now() - t0, ok: false, error: err.message };
  }
}

console.log(`── pages`);
for (const p of ["/", "/chat", "/memory", "/history", "/demo", "/use-cases"]) {
  const r = await hit(p);
  check(p, r.ok && r.text.includes("<title"), `${r.status} · ${r.ms}ms · ${Math.round(r.text.length / 1024)}KB`);
}

console.log(`\n── reads`);
for (const [label, path] of [
  ["health", "/healthz"],
  ["stats", "/api/stats"],
  ["ledger", "/api/ledger"],
  ["personas", "/api/demo/personas"],
  ["cases", "/cases.json"],
]) {
  const r = await hit(path);
  check(label, r.ok && r.json !== null, `${r.status} · ${r.ms}ms`);
}

console.log(`\n── a brand new person`);
const first = await hit("/api/chat", { method: "POST", body: { userId: USER, text: "hello, I am running a smoke test" } });
check("first turn answers", first.ok && Boolean(first.json?.reply), `${first.ms}ms`);
check("no error in meta", !first.json?.meta?.error, first.json?.meta?.error ?? "");

const mem = await hit(`/api/memory?userId=${USER}`);
check("memory reads", mem.ok && Array.isArray(mem.json?.facts), `${mem.json?.facts?.length ?? "?"} facts`);

const full = await hit(`/api/memory/full?userId=${USER}`);
check("dashboard reads", full.ok && Array.isArray(full.json?.facts), `${full.ms}ms`);
check("dashboard has stats", Boolean(full.json?.stats), JSON.stringify(full.json?.stats ?? {}).slice(0, 80));

const convos = await hit(`/api/conversations?userId=${USER}`);
check("conversations read", convos.ok && Array.isArray(convos.json?.conversations),
  `${convos.json?.conversations?.length ?? "?"} found`);
check("this conversation is listed", (convos.json?.conversations ?? []).some((c) => c.live));

console.log(`\n── guards`);
const noUser = await hit("/api/memory", { expect: 400 });
check("memory without userId is rejected", noUser.status === 400);

const badKey = await hit("/api/key/redeem", { method: "POST", body: { phrase: "not even close" }, expect: 404 });
check("a wrong memory key is rejected", badKey.status === 404);

// 204 is the answer; a 503 here is the relayer being briefly unavailable
// rather than the endpoint being wrong, so both count as "did not mint".
const unknownLink = await hit("/api/link/code", { method: "POST", body: { userId: "never-seen-" + Date.now() }, expect: 204 });
check("link code for an unknown browser mints nothing",
  unknownLink.status === 204 || unknownLink.status === 503, String(unknownLink.status));

const ssrf = await hit("/api/demo/chat", { method: "POST", body: { personaId: "nope", visitorId: "x", text: "hi" }, expect: 400 });
check("unknown persona is rejected", ssrf.status === 400);

// 200k base64 characters decode to about 150KB, which is legitimately under
// the limit — the earlier version of this test was measuring the wrong thing.
// 12MB of base64 is over both the body cap and the file cap.
const big = await hit("/api/attach", { method: "POST", body: { userId: USER, data: "A".repeat(13_000_000) }, expect: 413 });
check("oversized upload is rejected", big.status === 413 || big.status === 400, String(big.status));

console.log(failed ? `\n${failed} check(s) failed` : `\nall checks passed`);
process.exit(failed ? 1 : 0);
