#!/usr/bin/env node
/**
 * End-to-end check against Walrus mainnet.
 *
 *   npm run smoke
 *
 * Writes a handful of real blobs, so it costs WAL. Use it after an SDK bump or
 * a relayer change, not on every save.
 */

import { rememberFact, recall, learnFrom, health } from "../src/core/memory.mjs";
import { resolvePerson, issueLinkCode, redeemLinkCode } from "../src/core/identity.mjs";

const stamp = Date.now();
const NS = "ws8::test::smoke";
let failures = 0;

const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const h = await health();
check("relayer healthy", h.status === "ok" && h.write_ready === true, `${h.status}, write_ready=${h.write_ready}`);

const codename = `Halibut-${stamp}`;
const w = await rememberFact(NS, `smoke ${stamp}: the project codename is ${codename}.`);
check("remember returns a confirmed blob", Boolean(w.blobId) || w.pending, w.blobId ?? `pending job ${w.jobId}`);

const hits = await recall(NS, `what is the codename for smoke ${stamp}?`, { limit: 5 });
check("recall finds the fact just written", hits.some((x) => x.text.includes(codename)));
check("recall results carry created_at", hits.every((x) => x.created_at), "needed for newest-wins reads");

const learned = await learnFrom(NS, "User: I run Node 22 on a Mac and I keep hitting a 403 from the publisher endpoint. I already tried rotating my key.");
check("analyze extracts multiple facts", learned.facts.length >= 2, `${learned.facts.length} facts`);
check("every extracted fact stored", learned.failed.length === 0, `${learned.stored.length} stored, ${learned.failed.length} failed`);

// Cross-surface identity — the thing this bot is actually about.
const d = `discord-smoke-${stamp}`;
const t = `telegram-smoke-${stamp}`;
const pd = await resolvePerson("discord", d);
const pd2 = await resolvePerson("discord", d);
check("person id is stable per account", pd.personId === pd2.personId);

const pt = await resolvePerson("telegram", t);
check("separate accounts are separate people", pt.personId !== pd.personId);

const { code } = await issueLinkCode(pd.personId, "discord");
const redeemed = await redeemLinkCode("telegram", t, code);
check("link code redeems", redeemed.ok === true, redeemed.reason ?? "");

const ptAfter = await resolvePerson("telegram", t);
check("linked account resolves to the same person", ptAfter.personId === pd.personId);
check("pre-link memories are not orphaned", ptAfter.namespaces.length === 2, ptAfter.namespaces.join(", "));

check("unknown code rejected", (await redeemLinkCode("telegram", t, "ZZZZZZ")).ok === false);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
