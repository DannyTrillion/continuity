#!/usr/bin/env node
/**
 * Drive the app shell in a real browser and report what breaks.
 *
 *   BASE=https://… node tools/check-nav.mjs
 *
 * Chat, memory and history are panels in one document now, so the thing to
 * prove is that switching between them never reloads: the header stays the
 * same DOM node, the chat keeps what you typed, and the URL and back button
 * still behave. A syntax check cannot see any of that, and a screenshot of a
 * half-initialised page still looks fine.
 */
import puppeteer from "puppeteer-core";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE ?? "http://localhost:8080";
/**
 * One person, reused.
 *
 * A fresh id per run meant every run minted a person: an identity read, then
 * an identity write and a profile write, and when the relayer was busy those
 * writes queued and retried, spending more of the same 60-per-minute budget
 * the next run needed. The suite is about navigating between sections, not
 * about being new, so it is the same person every time — and what it checks
 * gets cheaper and more repeatable for it.
 */
const USER = process.env.AS_USER ?? "navcheck-resident";

let failures = 0;
const pass = (what, note = "") => console.log(`PASS  ${what}${note ? ` — ${note}` : ""}`);
const fail = (what, note = "") => { failures++; console.log(`FAIL  ${what}${note ? ` — ${note}` : ""}`); };
const check = (what, ok, note) => (ok ? pass(what, note) : fail(what, note));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument((id) => localStorage.setItem("ws8-user", id), USER);

let errors = [];
let missing = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));
page.on("requestfailed", (r) => missing.push(`${r.url().replace(BASE, "")} ${r.failure()?.errorText ?? ""}`));
page.on("response", (r) => {
  if (r.status() >= 400 && new URL(r.url()).origin === new URL(BASE).origin) {
    missing.push(`${r.url().replace(BASE, "")} → ${r.status()}`);
  }
});

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const shown = () => page.evaluate(() =>
  [...document.querySelectorAll(".panel")].filter((p) => !p.hidden).map((p) => p.dataset.panel));

/* ── every path serves the shell and opens on the right panel ─────────── */

console.log(`\n── deep links (as ${USER})\n`);
for (const [path, want] of [["/chat", "chat"], ["/memory", "memory"], ["/history", "history"]]) {
  errors = []; missing = [];
  await page.goto(BASE + path, { waitUntil: "networkidle2", timeout: 60000 });
  await settle(2500);
  const open = await shown();
  check(`${path} opens the ${want} panel`, open.length === 1 && open[0] === want, open.join(",") || "(none)");
  check(`${path} loads clean`, errors.length === 0, errors[0] ?? "");
  check(`${path} has no broken requests`, missing.length === 0, missing[0] ?? "");
}

/* ── switching never reloads ──────────────────────────────────────────── */

console.log("\n── switching sections\n");
await page.goto(BASE + "/chat", { waitUntil: "networkidle2", timeout: 60000 });
await settle(2500);

/**
 * Stamp the live document. Anything that survives a switch proves the page was
 * never replaced — which is the entire point of the shell. A full navigation
 * would wipe all of it.
 */
await page.evaluate(() => {
  window.__alive = Symbol("same document");
  document.querySelector(".top").dataset.stamp = "original";
  const box = document.querySelector("#composer, textarea, input[type=text]");
  if (box) box.value = "a half-typed thought";
});

for (const [href, want] of [["/memory", "memory"], ["/history", "history"], ["/chat", "chat"]]) {
  errors = [];
  const before = Date.now();
  // History no longer has a pill of its own — it is reached from the rail, or
  // directly. Click a real link when there is one, so this still exercises the
  // delegated handler rather than only the router's internals.
  await page.evaluate((h) => {
    const link = document.querySelector(`.nav a[href="${h}"]`) || document.querySelector(`a[href="${h}"]`);
    if (link) link.click();
    else Router.show(h.replace("/", ""));
  }, href);
  await page.waitForFunction(
    (w) => [...document.querySelectorAll(".panel")].some((p) => !p.hidden && p.dataset.panel === w),
    { timeout: 5000 }, want,
  ).catch(() => {});
  const took = Date.now() - before;
  await settle(700);

  const open = await shown();
  check(`→ ${want}: shows only that panel`, open.length === 1 && open[0] === want, open.join(",") || "(none)");
  check(`→ ${want}: url is ${href}`, new URL(page.url()).pathname === href, new URL(page.url()).pathname);
  check(`→ ${want}: switched in under 400ms`, took < 400, `${took}ms`);
  check(`→ ${want}: no errors`, errors.length === 0, errors[0] ?? "");

  const survived = await page.evaluate(() => ({
    doc: typeof window.__alive === "symbol",
    header: document.querySelector(".top").dataset.stamp === "original",
  }));
  check(`→ ${want}: document was never reloaded`, survived.doc);
  check(`→ ${want}: header is the same element`, survived.header);
}

/* What you had typed is still there after a round trip. */
const kept = await page.evaluate(() => {
  const box = document.querySelector("#composer, textarea, input[type=text]");
  return box ? box.value : null;
});
check("chat kept what you had typed", kept === "a half-typed thought", kept ?? "(no composer found)");

/* ── the back button ──────────────────────────────────────────────────── */

console.log("\n── back and forward\n");
await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
await settle(700);
check("back returns to history", new URL(page.url()).pathname === "/history", new URL(page.url()).pathname);
check("back still shows one panel", (await shown()).length === 1, (await shown()).join(","));
const stillAlive = await page.evaluate(() => typeof window.__alive === "symbol");
check("back did not reload either", stillAlive);

/* ── nothing is read twice ────────────────────────────────────────────── */

console.log("\n── what a lap costs\n");
const reads = [];
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.origin === new URL(BASE).origin && u.pathname.startsWith("/api/")) reads.push(u.pathname);
});
for (const href of ["/chat", "/memory", "/history", "/chat"]) {
  // History no longer has a pill of its own — it is reached from the rail, or
  // directly. Click a real link when there is one, so this still exercises the
  // delegated handler rather than only the router's internals.
  await page.evaluate((h) => {
    const link = document.querySelector(`.nav a[href="${h}"]`) || document.querySelector(`a[href="${h}"]`);
    if (link) link.click();
    else Router.show(h.replace("/", ""));
  }, href);
  await settle(900);
}
check("a full lap re-reads nothing", reads.length === 0, reads.length ? [...new Set(reads)].join(", ") : "0 requests");

/* ── the header: pills, the moving indicator, and the ⋯ menu ──────────── */

console.log("\n── the header\n");
await page.goto(BASE + "/chat", { waitUntil: "networkidle2", timeout: 60000 });
await settle(3000);

const pills = await page.evaluate(() => [...document.querySelectorAll(".nav a")].map((a) => a.dataset.nav));
/* Three tabs: what it's doing, what it knows, and how it works. History is
   deliberately not among them — it lives in the overflow menu, because
   somebody opens it occasionally and the nav is for the things they live in.
   The count matters as much as the names: a fourth tab stops the glide
   reading as one pill travelling and starts it reading as a toolbar. */
check("the nav carries Chat, Memory and Modes",
  pills.join(",") === "chat,memory,modes", pills.join(",") || "(none)");
check("and nothing more, so the glide still reads as one pill",
  pills.length === 3, `${pills.length} tabs`);

/**
 * The white pill must be ONE element that travels. Two tabs each fading their
 * own background in and out never reads as a single movement, however it is
 * timed — which is what made switching feel broken rather than slow.
 */
const spot = () => page.evaluate(() => {
  const d = document.getElementById("glide");
  const on = document.querySelector(".nav a.on");
  return { x: d?.style.transform ?? "", w: parseInt(d?.style.width) || 0, tabW: on?.offsetWidth ?? 0,
    faded: d?.style.opacity === "0" };
});
const atChat = await spot();
check("the pill is one travelling element", (await page.evaluate(() =>
  document.querySelectorAll("#glide").length === 1 && document.querySelector(".nav").classList.contains("glided"))));
check("it fits the active tab", atChat.w === atChat.tabW, `${atChat.w}px vs ${atChat.tabW}px`);

await page.evaluate(() => document.querySelector('.nav a[href="/memory"]').click());
await settle(700);
const atMemory = await spot();
check("it moves rather than re-fades", atChat.x !== atMemory.x, `${atChat.x} → ${atMemory.x}`);
check("it resizes to the new tab", atMemory.w === atMemory.tabW, `${atMemory.w}px vs ${atMemory.tabW}px`);

/* History has no pill any more, so the indicator has nothing to sit under. */
await page.evaluate(() => document.querySelector(".recents-h .seeall")?.click());
await page.goto(BASE + "/history", { waitUntil: "networkidle2", timeout: 60000 });
await settle(1500);
check("the pill steps aside on History", (await spot()).faded);

/**
 * Naming the header for a view transition makes it a stacking context, which
 * once trapped this menu's z-index inside it — the panels then painted over
 * the open menu. What matters is what the browser actually paints on top.
 */
await page.goto(BASE + "/chat", { waitUntil: "networkidle2", timeout: 60000 });
await settle(2500);
await page.evaluate(() => document.getElementById("morebtn").click());
await settle(400);
const menu = await page.evaluate(() => {
  const m = document.getElementById("menu");
  const r = m.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 16);
  return { open: m.classList.contains("on"), h: Math.round(r.height), onTop: m.contains(hit),
    covered: m.contains(hit) ? "" : (hit?.tagName + "." + (hit?.className || "")).slice(0, 40) };
});
check("the ⋯ menu opens", menu.open && menu.h > 0, `${menu.h}px tall`);
check("and is painted above the panel", menu.onTop, menu.covered);

/* ── recent conversations in the rail ─────────────────────────────────── */

console.log("\n── recents in the rail\n");
await page.evaluate(() => document.getElementById("morebtn").click()); // close it
await settle(300);
const rail = await page.evaluate(() => {
  const box = document.getElementById("recents");
  const rows = [...document.querySelectorAll(".rc")];
  return {
    hidden: box?.hidden !== false,
    rows: rows.length,
    first: rows[0] ? { title: rows[0].querySelector("b")?.textContent?.trim().slice(0, 40),
      meta: rows[0].querySelector("span")?.textContent?.trim() } : null,
    seeAll: document.querySelector(".recents-h .seeall")?.getAttribute("href"),
    scrolls: getComputedStyle(document.querySelector(".recents-list") ?? document.body).overflowY,
  };
});

if (rail.hidden) {
  // A user with no conversations should see no empty "Recent" header at all.
  pass("no conversations yet, so the section stays hidden");
} else {
  check("rows render", rail.rows > 0, `${rail.rows}`);
  check("each row names the app and when", /·/.test(rail.first?.meta ?? ""), rail.first?.meta ?? "");
  check("the list scrolls rather than growing", rail.scrolls === "auto", rail.scrolls);

  const before = await page.evaluate(() => document.querySelectorAll(".bubble,.turn,[class*=msg]").length);
  await page.evaluate(() => document.querySelector(".rc").click());
  await settle(2500);
  const after = await page.evaluate(() => ({
    msgs: document.querySelectorAll(".bubble,.turn,[class*=msg]").length,
    marked: document.querySelector(".rc")?.classList.contains("on"),
  }));
  check("clicking one opens that conversation", after.msgs > before, `${before} → ${after.msgs} messages`);
  check("and it shows as the open one", after.marked);
}
check('"See all" points at the archive', rail.seeAll === "/history", rail.seeAll ?? "(missing)");

/* ── how a section opens ──────────────────────────────────────────────── */

/**
 * The section appears instantly and its contents rise in on a stagger — the
 * pattern commonsmade.com uses. A cross-fade of the whole panel reads as one
 * page replacing another; this reads as a section opening.
 *
 * Animations are slowed through DevTools so the staged state can actually be
 * observed. At full speed it is over in well under a second.
 */
console.log("\n── the staged open\n");
await page.goto(BASE + "/chat", { waitUntil: "networkidle2", timeout: 60000 });
await settle(3000);

const cdp = await page.target().createCDPSession();
await cdp.send("Animation.enable");
await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });

await page.evaluate(() => document.querySelector('.nav a[href="/memory"]').click());
await settle(700); // 70ms of animation at this rate
const rise = await page.evaluate(() => {
  const pan = document.getElementById("p-memory");
  const o = (sel) => { const e = pan.querySelector(sel); return e ? Number(getComputedStyle(e).opacity) : null; };
  const first = pan.querySelector(".wrap > *");
  return {
    opening: pan.classList.contains("opening"),
    curve: first ? getComputedStyle(first).animationTimingFunction : "",
    name: first ? getComputedStyle(first).animationName : "",
    h1: o("h1"), list: o(".list"),
  };
});
check("the panel stages its contents", rise.opening);
check("using the enter-rise keyframe", rise.name === "enter-rise", rise.name || "(none)");
check("on commonsmade's curve", rise.curve.replace(/\s/g, "") === "cubic-bezier(0.22,1,0.36,1)", rise.curve);
check("heading leads the list", rise.h1 > rise.list, `${rise.h1?.toFixed(2)} vs ${rise.list?.toFixed(2)}`);

await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
await settle(1400);
check("and the class is cleaned up after", !(await page.evaluate(() =>
  document.getElementById("p-memory").classList.contains("opening"))));

/* ── skeletons ────────────────────────────────────────────────────────── */

console.log("\n── skeletons\n");
const fresh = await browser.newPage();
await fresh.setViewport({ width: 1440, height: 900 });
await fresh.evaluateOnNewDocument((id) => localStorage.setItem("ws8-user", id), "sk-" + Date.now());
await fresh.goto(BASE + "/memory", { waitUntil: "domcontentloaded", timeout: 60000 });
await settle(250);

const early = await fresh.evaluate(() => ({
  rows: document.querySelectorAll("#p-memory .sk-row").length,
  sweeping: [...document.querySelectorAll("#p-memory .sk")].some((e) =>
    getComputedStyle(e).animationName === "sk-sweep"),
  noLoadingText: !/Reading from Walrus/.test(document.querySelector("#p-memory .list")?.textContent ?? ""),
}));
check("a skeleton stands in while Walrus is read", early.rows > 0, `${early.rows} rows`);
check("and it shimmers", early.sweeping);
check("no bare loading sentence", early.noLoadingText);

await fresh.waitForFunction(() => document.querySelectorAll("#p-memory .sk-row").length === 0,
  { timeout: 40000 }).catch(() => {});
check("the skeleton is replaced by the real thing", await fresh.evaluate(() =>
  document.querySelectorAll("#p-memory .sk-row").length === 0));
await fresh.close();

/* ── the landing page's returning-visitor line ────────────────────────── */

/**
 * That line needs two Walrus-backed requests before it can be written, so it
 * used to sit hidden and then snap in, shoving the page down after everything
 * else had settled. It should hold its space with a skeleton and reveal.
 */
console.log("\n── the landing page\n");

/* The mascot took over what the old "carry" line did, and does it better: a
   face saying one thing it remembers about you beats a sentence asserting
   that it remembers. What matters is the same, though — it must never claim
   to know someone it has never met. */
const back = await browser.newPage();
await back.setViewport({ width: 1440, height: 950 });
await back.evaluateOnNewDocument((id) => localStorage.setItem("ws8-user", id), USER);
await back.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });

await back.waitForFunction(() => {
  const b = document.getElementById("bubble");
  return b && !b.hidden && b.textContent.trim().length > 0;
}, { timeout: 45000 }).catch(() => {});

const spoke = await back.evaluate(() => {
  const b = document.getElementById("bubble");
  return { said: (b?.textContent ?? "").replace(/\s+/g, " ").trim(), hasOrb: !!document.getElementById("orb") };
});
check("the mascot is there", spoke.hasOrb);
check("and it speaks to a browser it has met", spoke.said.length > 0, spoke.said.slice(0, 80));
/* Third person is how a fact is stored and wrong for a face talking to you.
   "User uses pnpm" reaching the page unchanged is the failure to catch. */
check("in the second person, not the third",
  !/\b(the )?user\b/i.test(spoke.said), spoke.said.slice(0, 80));
check("and without the name said twice", !/welcome back, (\w+)\..*your name is \1/i.test(spoke.said), spoke.said.slice(0, 80));

const stranger = await (await browser.createBrowserContext()).newPage();
await stranger.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await settle(3200);
check("a first-time visitor is told what it does, never what it knows",
  await stranger.evaluate(() => {
    const t = (document.getElementById("bubble")?.textContent ?? "").toLowerCase();
    return !/welcome back|you use|you are on|you have/.test(t);
  }));
await stranger.close();

/* ── attachments actually reach the model ────────────────────────────── */

/**
 * Two separate bugs once stacked here and cancelled out any sign of trouble:
 * the composer sent `pending` after clearing it (so always null), and the
 * streaming route never destructured `attachment` at all. The upload worked,
 * the vision model described the image, the thumbnail appeared in the
 * bubble — and the bot said it could not see images. Nothing errored.
 *
 * So this drives the real file input and reads the real answer. Anything less
 * would have passed happily while the feature was dead.
 */
console.log("\n── attachments\n");
await page.goto(BASE + "/chat", { waitUntil: "networkidle2", timeout: 60000 });
await settle(2500);

const shot = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "assets", "texture.jpg");
const input = await page.$("#file");
if (!input) {
  fail("the composer has a file input");
} else {
  await input.uploadFile(shot);
  // Deliberately send WITHOUT waiting for the description to finish. Someone
  // who attaches and types straight away hits exactly this, and it used to
  // drop the attachment on the floor.
  await page.waitForFunction(() => !document.getElementById("attached").hidden,
    { timeout: 30000 }).catch(() => {});

  const carried = await page.evaluate(() => {
    const sent = [];
    const real = window.fetch;
    window.fetch = (u, o) => {
      if (String(u).includes("/api/chat")) {
        try { sent.push(JSON.parse(o.body).attachment); } catch { sent.push("unparseable"); }
      }
      return real(u, o);
    };
    window.__sent = sent;
    return true;
  });
  void carried;

  await page.evaluate(() => {
    const box = document.querySelector("#composer, textarea, input[type=text]");
    box.value = "what is in the image I just sent?";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("send").click();
  });

  /* Done is the send button coming back, not merely text appearing: while a
     turn is in flight the bubble holds the slate — "Reading your memory", a
     clock — which is text enough to fool a looser test into reading the
     outgoing request before it has been sent. */
  await page.waitForFunction(() => {
    if (document.getElementById("send")?.disabled) return false;
    const bots = [...document.querySelectorAll(".turn.bot, .bot")];
    const last = bots[bots.length - 1];
    return last && last.textContent.trim().length > 30 && !last.querySelector(".slate");
  }, { timeout: 90000 }).catch(() => {});
  await settle(500);

  const out = await page.evaluate(() => {
    const bots = [...document.querySelectorAll(".turn.bot, .bot")];
    return {
      attachmentSent: (window.__sent ?? []).some((a) => a && a !== "unparseable" && a.description),
      reply: (bots[bots.length - 1]?.textContent ?? "").trim().slice(0, 160),
    };
  });
  check("the request carries the description", out.attachmentSent);
  check("and the bot does not deny seeing it",
    !/(can'?t|cannot|don'?t|do not|unable to)\s+(see|view)|no image|any image|text-only/i.test(out.reply),
    out.reply.slice(0, 90));
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
