#!/usr/bin/env node
/**
 * Every page, every main interaction, without touching Walrus.
 *
 *   node tools/check-ui.mjs            (against http://localhost:8080)
 *   BASE=https://… node tools/check-ui.mjs
 *
 * The relayer allows a thousand weighted requests an hour and the other
 * suites spend them: a run of check-nav during a busy hour fails on 429s that
 * say nothing about the code. This one answers every /api call from fixtures
 * in the browser, so it tests what the pages do with data, not whether the
 * relayer felt like providing any. Pages, styles and scripts still come from
 * the real server.
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE ?? "http://localhost:8080";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};
const section = (t) => console.log(`\n── ${t}`);

const BLOB = "Z1cIvEkRupcxa7e1qMWDZOFxADuV338tlYwF2dvh0Do";
const fact = (text, wroteOn = "web", crossed = false, readCount = 1) => ({
  text, at: "2026-09-27T10:00:00Z", blobId: BLOB, distance: 0.3,
  provenance: { wroteOn, crossed, readCount, surfaces: crossed ? ["telegram", "web"] : [wroteOn] },
});
const FACTS = [
  fact("User's name is Danny", "telegram", true, 3), fact("User uses pnpm, never npm", "telegram", true, 2),
  fact("User is on Node 22", "telegram", false, 0), fact("User's preference: short answers, in a plain, direct tone."),
  fact("User is planning a trip to Lisbon on 3 Nov 2026"), fact("User is building a CLI that turns screenshots into alt text"),
  fact("User keeps getting a 403 from the Walrus publisher"), fact("User lives in Lagos", "discord", true, 4),
];
const PICTURES = [{ file: "506fcf59-1842-4f11-8fd9-c7deaa955125.png", url: "/assets/shots/picture.jpg", available: true, surface: "web",
  name: "skating.png", description: "A light blue graphic with an ice skate.", said: "me ice skating", at: "2026-09-26T22:00:00Z", blobId: BLOB }];

/* Three files, one per state the shelf has to tell apart: on the volume and
   on Walrus, off the volume but recoverable from Walrus, and gone from both.
   The middle one is the whole point of putting bytes on Walrus — before that
   it was indistinguishable from the last. */
const FILES = [
  { file: "lease.pdf", url: "/uploads/lease.pdf", available: true, onDisk: true, surface: "telegram",
    name: "lease.pdf", pages: 9, said: "keep this somewhere safe",
    walrusBlob: "nMxaSHx54ESfmruT6HCCOnVlGTZdmtRc3JPn-hLJ-zc",
    description: "A residential tenancy agreement for 14 Oak Road, twelve months from 1 November.",
    at: "2026-10-02T09:00:00Z", blobId: "FILEBLOB00000000000000000000000000000000000" },
  { file: "gone.md", url: "/blob/8uX9lijwxorrfGQeNv51sqdHc7jmRxCmNvMruQ4WIxE", available: true, onDisk: false, surface: "web",
    name: "runbook.md", pages: null, said: null,
    walrusBlob: "8uX9lijwxorrfGQeNv51sqdHc7jmRxCmNvMruQ4WIxE",
    description: "A deployment runbook: Railway, volume at /data, deploy with railway up.",
    at: "2026-09-28T09:00:00Z", blobId: null },
  { file: "lost.txt", url: null, available: false, onDisk: false, surface: "discord",
    name: "scratch.txt", pages: null, said: null, walrusBlob: null,
    description: "A scratch file written before attachments went to Walrus.",
    at: "2026-09-20T09:00:00Z", blobId: null },
];
const CONVOS = Array.from({ length: 7 }, (_, i) => ({ id: "c" + i, title: ["Teach me recursion", "Plan my Lisbon trip", "Why does my build fail", "Name my side project", "Interview prep", "What do you know about me?", "Read this link"][i],
  surface: ["web", "telegram", "discord"][i % 3], startedAt: "2026-09-27T10:00:00Z", endedAt: "2026-09-27T10:0" + i + ":00Z", turns: 2, live: false, blobId: BLOB }));
const SSE = [
  { s: { stage: "thinking", recalled: 3, pictures: 0, ms: 640 } }, { t: "You use " }, { t: "pnpm, never npm." },
  { done: true, reply: "You use **pnpm**, never npm.", meta: { recalled: { personal: 3, kb: 0 }, trace: [] },
    actions: [{ id: "switch-tutor", label: "Switch to Tutor", say: "/mode tutor" }] },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

/* `/link` is answered through the same stream as ordinary conversation, so a
   fixture that always replies about pnpm meant the linking panel could never
   receive a code and the whole control looked broken under test while working
   in the browser. The reply carries a code the way the real one does. */
const SSE_LINK = [
  { s: { stage: "thinking", recalled: 0, pictures: 0, ms: 120 } },
  { done: true, reply: "Your code is HTQ8PB — it expires in 10 minutes. Send /link HTQ8PB from another surface and I'll know it's the same you.",
    meta: { recalled: { personal: 0, kb: 0 }, trace: [] }, actions: [] },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

let receipts = [];
let lastSaid = null;                 // what the page last sent to be answered
function answer(url, method, body) {
  const p = url.pathname;
  const json = (o, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(o) });
  if (p === "/api/memory") return json({ personId: "p1", linked: true, connected: ["web", "telegram", "discord"], name: "Danny", facts: FACTS.map(({ text, at, blobId }) => ({ text, at, blobId })) });
  if (p === "/api/memory/full") return json({ personId: "p1", name: "Danny", connected: ["web", "telegram", "discord"], facts: FACTS, pictures: PICTURES, files: FILES,
    stats: { total: FACTS.length, collapsed: 1, suppressed: 0, namespaces: 3, crossSurface: 3, neverRead: 1 } });
  if (p === "/api/conversations") return json({ conversations: CONVOS });
  if (p === "/api/conversations/open") return json({ conversation: { id: "c0", title: "Teach me recursion", turns: [{ you: "Teach me recursion", bot: "Start with a **base case**." }] }, restored: 2 });
  if (p === "/api/ledger") return json({ writes: [{ at: "2026-09-27T10:00:00Z", blobId: BLOB, namespace: "ws8::person::p1", kind: "analyze" }], total: 1 });
  if (p === "/api/stats") return json({ model: "moonshotai/kimi-k2.5", metrics: {}, outbox: { pending: 0 }, blobsLedger: 50, surfaces: { web: true, telegram: true, discord: true }, botUsername: "walrusmemory_bot", discordInvite: "https://discord.gg/example" });
  if (p === "/api/chat/stream") { lastSaid = body?.text ?? null;
    return { status: 200, contentType: "text/event-stream", body: /^\/link\b/.test(body?.text ?? "") ? SSE_LINK : SSE }; }
  if (p === "/api/chat") return json({ reply: "You use **pnpm**, never npm.", meta: { recalled: { personal: 3, kb: 0 }, trace: [] } });
  if (p === "/api/session/restore") return json({ restored: 0, kept: true });
  /* Shape copied from the live endpoint, not invented: it answers
     expiresInMinutes, and a fixture saying expiresInSeconds quietly tested a
     response the server has never sent. */
  if (p === "/api/link/code") return json({ code: "HTQ8PB", expiresInMinutes: 10, personId: "p1" });
  if (p === "/api/attach") return json({ id: "a1", file: "a1.jpg", url: "/assets/shots/picture.jpg", name: "beach.jpg", type: "image/jpeg", description: "A man in a white cap by the water.", sawIt: true });
  if (p === "/api/onboard/step") {
    const step = body?.step ?? "name";
    const text = { name: "User's name is Danny", jobs: "User's preference: wants the assistant as a tutor for learning new things.", style: "User's preference: short answers.", tools: "User uses pnpm and Node.", picture: "me at the beach" }[step] ?? step;
    receipts = [...receipts.filter((r) => r.step !== step), { step, text, blobId: BLOB, at: "2026-09-29T00:00:00Z" }];
    return json({ ok: true, saved: true, receipts });
  }
  if (p === "/api/onboard/status") return json({ receipts });
  if (p === "/api/onboard/finish") return json({ ok: true, receipts });
  if (p === "/api/onboard/state") return json({ done: false });
  if (p === "/api/demo/personas") return json({ personas: [
    { id: "registrar", name: "Registrar", org: "Northgate University", tagline: "Enrolment and deadlines.", why: "", proof: "", starters: ["When is the deadline?"] },
    { id: "tutor", name: "Tutor", org: "Programming", tagline: "Picks up where you got stuck.", why: "", proof: "", starters: ["I'm stuck"] },
    { id: "support", name: "Support", org: "Walrus", tagline: "Knows your stack.", why: "", proof: "", starters: ["403 from publisher"] }] });
  if (p.startsWith("/api/")) return json({});
  return null;
}

const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox"], protocolTimeout: 60000, timeout: 60000 });

async function open(path, { width = 1440, height = 900, store = {}, context } = {}) {
  // A profile of its own per check, unless one is handed in: what one check
  // leaves in storage must not decide the next.
  const ctx = context ?? await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.ctx = ctx;
  await page.setViewport({ width, height });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|fonts\.g/.test(m.text())) errors.push(m.text().slice(0, 140)); });
  page.on("requestfailed", (r) => { if (r.url().startsWith(BASE) && !/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) errors.push("failed " + r.url().replace(BASE, "")); });
  page.on("response", (r) => { if (r.url().startsWith(BASE) && r.status() >= 400) errors.push(r.status() + " " + r.url().replace(BASE, "")); });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = new URL(req.url());
    let body = null; try { body = JSON.parse(req.postData() ?? "null"); } catch {}
    const a = url.origin === new URL(BASE).origin ? answer(url, req.method(), body) : null;
    a ? req.respond(a) : req.continue();
  });
  // `store: null` is a browser that has never been here, which is a different
  // page for the parts of the site that greet a stranger differently.
  if (store !== null) {
    await page.evaluateOnNewDocument((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); },
      { "ws8-user": "ui-check", "ws8-onboarded": "done", ...store });
  }
  await page.mouse.move(2, 2);
  await page.goto(BASE + path, { waitUntil: "networkidle0" });
  await sleep(900);
  return { page, errors };
}
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const count = (page, sel) => page.$$eval(sel, (e) => e.length);
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => null);

try {
  /* ── every page loads, clean, on a laptop and on a phone ── */
  section("every page, two sizes");
  for (const path of ["/", "/chat", "/memory", "/history", "/use-cases", "/docs", "/demo", "/welcome"]) {
    for (const [w, h] of [[1440, 900], [400, 860]]) {
      const { page, errors } = await open(path, { width: w, height: h });
      check(`${path} @${w} loads clean`, errors.length === 0, errors.length ? errors.slice(0, 2) : "");
      check(`${path} @${w} does not scroll sideways`, await fits(page));
      if (w === 400 && (await count(page, "#morebtn"))) check(`${path} @${w} keeps the menu on screen`,
        await page.$eval("#morebtn", (e) => e.getBoundingClientRect().right <= innerWidth + 1));
      if (w === 1440 && !["/docs", "/welcome"].includes(path)) check(`${path} has the docs button`, (await count(page, ".docs-fab")) === 1);
      await page.close();
    }
  }

  /* ── the front door ── */
  section("the front door");
  { const a = await open("/", { store: null });
    check("a first-time visitor is sent to the introduction",
      (await a.page.$eval(".actions .go", (e) => new URL(e.href).pathname)) === "/welcome");
    await a.page.close();
    const b2 = await open("/");
    check("someone it has met goes straight to the chat",
      (await b2.page.$eval(".actions .go", (e) => new URL(e.href).pathname)) === "/chat");
    check("and the introduction is one tap to leave",
      (await (await open("/welcome", { store: null })).page.$eval("#skipall", (e) => e.textContent.trim())).length > 0);
    await b2.page.close(); }

  /* ── landing ── */
  section("landing");
  { const { page, errors } = await open("/");
    check("hero and both app buttons", (await count(page, ".actions .go")) === 1 && (await count(page, ".actions .alt")) >= 1);
    const rest = await page.$eval(".cue", (el) => { const m = new DOMMatrix(getComputedStyle(el).transform); return +(Math.atan2(m.b, m.a) * 180 / Math.PI).toFixed(1); });
    check("card rests at a visible tilt", Math.abs(rest) >= 4, rest + "°");
    const r = await page.$eval(".cue", (el) => { const q = el.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; });
    await page.mouse.move(r.x, r.y); await sleep(1100);
    const hov = await page.$eval(".cue", (el) => { const m = new DOMMatrix(getComputedStyle(el).transform); return +(Math.atan2(m.b, m.a) * 180 / Math.PI).toFixed(1); });
    await page.mouse.move(2, 2); await sleep(250);
    const mid = await page.$eval(".cue", (el) => { const m = new DOMMatrix(getComputedStyle(el).transform); return +(Math.atan2(m.b, m.a) * 180 / Math.PI).toFixed(1); });
    check("card squares up on hover", Math.abs(hov) < 0.5, hov + "°");
    check("and eases back rather than snapping", mid > 0.5 && mid < rest - 0.2, mid + "° a quarter-second after leaving");
    const glow = await page.evaluate(async () => { const a = document.querySelector(".actions .alt"); a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); return getComputedStyle(a).boxShadow; });
    check("buttons carry no glow", glow === "none", glow);
    check("no errors", errors.length === 0, errors.slice(0, 2));
    await page.close(); }

  /* ── chat ── */
  section("chat");
  { const { page, errors } = await open("/chat");
    check("rail greets by name", /Danny/.test(await text(page, "#memcount") ?? ""), await text(page, "#memcount"));
    check("all three apps shown connected", (await count(page, ".sf")) === 3);
    check("recent conversations listed", (await count(page, ".rc")) >= 5, await count(page, ".rc"));
    check("the quick controls are all there", (await count(page, "#quick .qc")) === 6,
      (await page.$$eval("#quick .qc", (els) => els.map((e) => e.textContent.trim()))).join(" · "));
    check("no invitation for someone it knows", (await count(page, ".invite")) === 0);
    await page.focus("#input"); await page.keyboard.type("what package manager do I use?"); await page.click("#send");
    await page.waitForFunction(() => !document.querySelector("#send").disabled, { timeout: 15000 });
    await sleep(300);
    check("the reply renders, formatted", /pnpm/.test(await text(page, ".turn.bot .bubble") ?? "") && (await count(page, ".turn.bot .bubble b")) === 1, await text(page, ".turn.bot .bubble"));
    check("both speakers are labelled", (await count(page, ".turn .who")) === 2);
    check("bubbles are glass", await page.$eval(".turn.bot .bubble", (e) => /blur/.test(getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter || "")));
    check("the slate is gone once it has answered", (await count(page, ".slate")) === 0);

    // What it offered to do next, drawn here as chips — the same actions the
    // bots draw as buttons.
    check("an offer appears as a chip", (await count(page, ".offer .chip")) === 1, await text(page, ".offer .chip"));
    check("saying what it would do", /Switch to Tutor/.test(await text(page, ".offer .chip") ?? ""));
    await page.click(".offer .chip"); await sleep(900);
    check("taking it says the thing it stood for", lastSaid === "/mode tutor", lastSaid);
    check("a way to pick how it works is in reach",
      (await page.$$eval("#quick .qc", (els) => els.map((e) => e.textContent.trim()))).some((t) => /how you work/i.test(t)));
    await page.reload({ waitUntil: "networkidle0" }); await sleep(800);
    check("a reload keeps the conversation", (await count(page, ".turn")) === 2, await count(page, ".turn"));
    await page.click("#newchat-q"); await sleep(300);
    check("New chat clears it", (await count(page, ".turn")) === 0 && (await count(page, ".welcome")) === 1);
    await page.reload({ waitUntil: "networkidle0" }); await sleep(600);
    check("and it stays cleared", (await count(page, ".turn")) === 0);
    await page.click("[data-prefill]"); await sleep(150);
    check("Bring back a picture prefills the composer", /picture/.test(await page.$eval("#input", (e) => e.value)));
    await page.click(".rc"); await sleep(900);
    check("a recent conversation reopens", (await count(page, ".turn")) >= 2 && (await count(page, ".rc.on")) === 1);
    await page.setViewport({ width: 1440, height: 620 }); await sleep(300);
    const sc = await page.$eval(".recents-list", (l) => { l.scrollTop = 9999; return { top: l.scrollTop, over: l.scrollHeight - l.clientHeight }; });
    check("the recents list scrolls when the window is short", sc.over <= 0 || sc.top > 0, sc);
    check("no errors", errors.length === 0, errors.slice(0, 2));
    await page.close(); }
  { const { page } = await open("/chat?ask=" + encodeURIComponent("Teach me recursion"));
    check("a handed-over question lands in the composer, unsent", (await page.$eval("#input", (e) => e.value)) === "Teach me recursion" && (await count(page, ".turn")) === 0);
    await page.close(); }
  { const { page } = await open("/chat", { store: { "ws8-onboarded": "" } });
    await page.evaluate(() => localStorage.removeItem("ws8-onboarded"));
    check("(someone it knows is still not invited)", (await count(page, ".invite")) === 0);
    await page.close(); }

  /* ── the app on a phone ── */
  section("the app on a phone");
  { const { page, errors } = await open("/chat", { width: 390, height: 844 });
    const g = await page.evaluate(() => { const q = (s) => document.querySelector(s).getBoundingClientRect();
      return { rail: getComputedStyle(document.querySelector(".rail")).display, page: document.documentElement.scrollHeight <= innerHeight + 1,
        composer: Math.round(q("#form").bottom), chatTop: Math.round(q(".chat").top), win: innerHeight, fab: getComputedStyle(document.querySelector(".docs-fab")).display }; });
    check("the chat is the whole screen: no rail", g.rail === "none");
    check("the page itself does not scroll", g.page);
    check("the composer sits at the bottom of the screen", g.win - g.composer < 24, g);
    check("the docs button is out of the send button's way", g.fab === "none");
    await page.click("#morebtn"); await sleep(250);
    const items = await page.$$eval("#menu > *", (els) => els.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.textContent.trim()));
    check("what the rail offered is in the menu", items.includes("Past conversations") && items.includes("Docs"), items.slice(0, 3));
    await page.click('#menu a[href="/history"]'); await sleep(800);
    const swipe = async (id) => { const at = await page.$eval(id, (e) => { const q = e.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height * .8 }; });
      const cdp = await page.createCDPSession(); await cdp.send("Input.synthesizeScrollGesture", { x: at.x, y: at.y, yDistance: -400, gestureSourceType: "touch", speed: 1600 }); await sleep(350);
      return page.$eval(id, (e) => ({ moved: Math.round(e.scrollTop), room: e.scrollHeight - e.clientHeight })); };
    const h = await swipe("#p-history");
    check("history scrolls under a thumb", h.room <= 0 || h.moved > 0, h);
    await page.click('.nav a[href="/memory"]'); await sleep(900);
    const m = await swipe("#p-memory");
    check("memory scrolls under a thumb", m.room > 0 && m.moved > 0, m);
    await page.click('.nav a[href="/modes"]'); await sleep(900);
    const md = await swipe("#p-modes");
    check("modes scrolls under a thumb", md.room > 0 && md.moved > 0, md);

    /* Every reading panel has to scroll itself, and the way this broke was by
       naming them: the shell granted overflow to #p-memory and #p-history, a
       third panel was added, inherited `flex: 1` with no overflow, and clipped
       silently. So the rule is checked as a rule rather than panel by panel —
       a fourth one added tomorrow is covered without anyone remembering. */
    const clipped = await page.$$eval(".panel", (ps) =>
      ps.filter((el) => el.id !== "p-chat")
        .filter((el) => getComputedStyle(el).overflowY !== "auto")
        .map((el) => el.id));
    check("every reading panel can scroll, not just the named ones", clipped.length === 0, clipped);
    check("and the header stays where it is", await page.$eval(".top", (e) => Math.round(e.getBoundingClientRect().top) >= 0));
    check("no errors", errors.length === 0, errors.slice(0, 2));
    await page.close(); }

  /* ── moving between sections ── */
  section("sections");
  { const { page, errors } = await open("/chat");
    const stamp = await page.evaluate(() => (window.__stamp = Math.random()));
    for (const to of ["memory", "chat", "history", "chat"]) {
      // History is reached from "See all" in the rail; it has no tab of its own.
      const t0 = Date.now(); await page.click(to === "history" ? ".recents-h .seeall" : `.nav a[href="/${to}"]`); await sleep(60);
      const shown = await page.$$eval(".panel", (ps) => ps.filter((p) => !p.hidden).map((p) => p.dataset.panel));
      check(`→ ${to} shows only that section`, shown.length === 1 && shown[0] === to, shown);
      check(`→ ${to} without a reload`, (await page.evaluate(() => window.__stamp)) === stamp, (Date.now() - t0) + "ms");
      await sleep(700);
    }
    check("no errors", errors.length === 0, errors.slice(0, 2));
    await page.close(); }

  /* ── memory ── */
  section("memory");
  { const { page, errors } = await open("/memory");
    const covers = await page.$$eval(".cover", (e) => e.map((c) => c.dataset.col + ":" + c.querySelector(".n").textContent));
    check("shelves with counts", covers.length >= 5 && covers.includes("photos:1"), covers);
    check("an answer given on purpose is a preference", covers.some((c) => /^prefs:[1-9]/.test(c)));
    check("covers are drawn in type", (await count(page, ".cover .figure")) >= 4);
    await page.click('.cover[data-col="setup"]'); await sleep(700);
    check("a shelf opens into its memories", (await count(page, ".memo")) >= 2 && /setup/i.test(await text(page, ".colhead h2") ?? ""));
    check("each memory links to its blob", (await count(page, ".memo .verify")) >= 2);
    await page.goBack(); await sleep(600);
    check("back returns to the shelf", (await count(page, ".cover")) === covers.length);
    await page.click('.cover[data-col="photos"]'); await sleep(700);
    await page.click(".photo"); await sleep(500);
    check("a photo opens in the lightbox", await page.$eval("#lb", (e) => e.classList.contains("on")));
    await page.keyboard.press("Escape"); await sleep(300);
    check("Escape closes it", !(await page.$eval("#lb", (e) => e.classList.contains("on"))));

    /* Files used to be written into the picture bank, so a PDF of someone's
       lease sat under Photos and the shelf people would look on did not
       exist. It does now, and it has to show what is really kept: the summary
       (which is the part on Walrus) rather than the filename, and an honest
       state for a file whose bytes a redeploy has taken. */
    await page.goBack(); await sleep(600);
    await page.click('.cover[data-col="files"]'); await sleep(700);
    const rows = await page.$$eval(".filerow", (e) => e.map((r) => ({
      head: r.querySelector("b")?.textContent ?? "",
      body: r.querySelector("p")?.textContent ?? "",
      foot: r.querySelector(".memofoot")?.textContent.replace(/\s+/g, " ").trim() ?? "",
    })));
    check("the files shelf opens into the files", rows.length === FILES.length, rows.length);
    check("each one leads with what the file said, not what it was called",
      /tenancy agreement/.test(rows[0]?.body ?? ""), rows[0]?.body?.slice(0, 50));
    check("the name is still there, with its kind", /lease\.pdf/.test(rows[0]?.head ?? ""), rows[0]?.head);
    check("and the page count and which app it came from", /9 pages/.test(rows[0]?.foot ?? "") && /telegram/i.test(rows[0]?.foot ?? ""), rows[0]?.foot);
    check("a file still on disk offers to open", (await count(page, '.filerow a[href^="/uploads/"]')) === 1);
    /* The state that only exists because the bytes go to Walrus: gone from
       this server, still openable. Before that this row and the next one were
       the same row, and both of them were an apology. */
    check("one off the volume is served from Walrus instead",
      /served from Walrus/.test(rows[1]?.foot ?? "") && (await count(page, '.filerow a[href^="/blob/"]')) === 1,
      rows[1]?.foot);
    check("and the Walrus link points at the explorer for the right network",
      await page.$eval('.filerow a.wal', (a) => /walruscan\.com\/(main|test)net\/blob\//.test(a.href)));
    check("a file on both says so without crying wolf",
      /also on Walrus/.test(rows[0]?.foot ?? ""), rows[0]?.foot);
    check("and one that reached neither is honestly marked lost",
      /not recoverable/.test(rows[2]?.foot ?? ""), rows[2]?.foot);
    await page.goBack(); await sleep(600);

    await page.type("#q", "node"); await sleep(400);
    check("search cuts across shelves", (await count(page, ".memo")) === 1, await count(page, ".memo"));
    check("no errors", errors.length === 0, errors.slice(0, 2));
    await page.close(); }

  /* ── history ── */
  section("history");
  { const { page, errors } = await open("/history");
    check("conversations listed", (await count(page, "#p-history .convo")) === CONVOS.length, await count(page, "#p-history .convo"));
    check("no errors", errors.length === 0, errors.slice(0, 2));
    await page.close(); }

  /* ── what it does ── */
  section("what it does");
  { const { page, errors } = await open("/use-cases");
    check("six capabilities on one screen", (await count(page, ".tile")) === 6 && await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));
    check("chapter five is about jobs, not three roles", /job/i.test(await text(page, ".tile:nth-child(5) h2") ?? ""), await text(page, ".tile:nth-child(5) h2"));
    await page.mouse.move(800, 300); await sleep(700);
    check("a hovered tile itself does not move", (await page.$eval(".tile:nth-child(2)", (e) => getComputedStyle(e).transform)) === "none");
    await page.mouse.move(2, 2);
    await (await page.$$(".tile"))[1].click(); await sleep(1200);
    check("a tile opens the stage on it", !(await page.$eval("#stage", (e) => e.hidden)) && /picture/i.test(await text(page, ".tab.on b") ?? ""), await text(page, ".tab.on b"));
    await sleep(7200);
    check("it moves on by itself", !/picture/i.test(await text(page, ".tab.on b") ?? ""), await text(page, ".tab.on b"));
    await (await page.$$(".tab"))[4].click(); await sleep(900);
    check("six jobs, each with something to try", (await count(page, ".job")) === 6 && (await count(page, '.job[href^="/chat?ask="]')) === 5);
    await sleep(7200);
    check("and stays put once a tab was chosen", /job/i.test(await text(page, ".tab.on b") ?? ""), await text(page, ".tab.on b"));
    await page.keyboard.press("Escape"); await sleep(1000);
    check("Escape returns to all six", !(await page.$eval("#bento", (e) => e.hidden)));
    check("no errors", errors.length === 0, errors.slice(0, 2));
    await page.close(); }

  /* ── what it does, on a phone ── */
  section("what it does, on a phone");
  { const { page, errors } = await open("/use-cases", { width: 390, height: 844 });
    const tiles = await page.evaluate(() => [...document.querySelectorAll(".tile")].filter((t) => {
      const words = [...t.querySelectorAll("h2, p, .open, .num")].map((e) => e.getBoundingClientRect());
      const v = t.querySelector(".peek, .jobs-mini, .steps-mini").getBoundingClientRect();
      return words.some((q) => !(q.bottom <= v.top + 1 || v.bottom <= q.top + 1 || q.right <= v.left + 1 || v.right <= q.left + 1));
    }).length);
    check("no tile's picture covers its words", tiles === 0, tiles + " overlapping");
    for (const id of ["cross-app", "pictures", "check", "resume", "jobs", "recovery"]) {
      await page.goto(BASE + "/use-cases#" + id, { waitUntil: "networkidle0" }); await sleep(700);
      const r = await page.evaluate(() => {
        const box = (e) => e.getBoundingClientRect(), f = box(document.getElementById("fig")), c = box(document.getElementById("copy"));
        return {
          overlap: !(c.bottom <= f.top + 1 || f.bottom <= c.top + 1),
          sideways: document.documentElement.scrollWidth > innerWidth + 1,
          clipped: [...document.querySelectorAll("#fig .frame, #fig .handoff, #fig .jobs, #fig .job")].filter((e) => e.scrollHeight > e.clientHeight + 2).length,
          wordsFirst: c.top < f.top,
        };
      });
      check(`#${id}: words, then picture, nothing on top of anything`, !r.overlap && !r.sideways && !r.clipped && r.wordsFirst, r);
    }
    check("no errors", errors.length === 0, errors.slice(0, 2));
    await page.close(); }

  /* ── docs ── */
  section("docs");
  { const { page, errors } = await open("/docs");
    const n = await count(page, ".card");
    check("one card per section", n >= 12, n);
    await sleep(5400);
    check("the carousel turns by itself", (await text(page, "#at")) !== "01", await text(page, "#at"));
    await page.click("#auto"); await page.click("#next"); await sleep(700);
    const at = Number(await text(page, "#at")) - 1;
    await (await page.$$(".card"))[at].click(); await sleep(900);
    check("a card pops out into the reader", await page.$eval("#reader", (e) => e.classList.contains("on")) && (await page.$eval("#r-body", (e) => e.children.length)) > 0, await text(page, "#r-title"));
    await page.keyboard.press("Escape"); await sleep(700);
    check("closing puts the section back", !(await page.$eval("#reader", (e) => e.classList.contains("on"))) && await page.$$eval("#store section", (s) => s.every((x) => x.children.length > 0)));
    await page.close();
    const v2 = await open("/docs#what-s-next-v2");
    check("a link to the v2 plan opens it", /next/i.test(await text(v2.page, "#r-title") ?? ""), await text(v2.page, "#r-title"));
    check("no errors", errors.length === 0 && v2.errors.length === 0, [...errors, ...v2.errors].slice(0, 2));
    await v2.page.close(); }

  /* ── the introduction ── */
  section("introduction");
  { receipts = [];
    const fresh = await (await browser.createBrowserContext()).newPage(); await fresh.setViewport({ width: 1440, height: 900 });
    const ferrs = []; fresh.on("pageerror", (e) => ferrs.push(e.message));
    await fresh.setRequestInterception(true);
    fresh.on("request", (req) => {
      const url = new URL(req.url()); let body = null; try { body = JSON.parse(req.postData() ?? "null"); } catch {}
      if (url.pathname === "/api/memory") return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ personId: "p2", linked: false, connected: ["web"], name: null, facts: [] }) });
      if (url.pathname === "/api/conversations") return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [] }) });
      const a = url.origin === new URL(BASE).origin ? answer(url, req.method(), body) : null;
      a ? req.respond(a) : req.continue();
    });
    await fresh.evaluateOnNewDocument(() => localStorage.setItem("ws8-user", "ui-new"));
    await fresh.goto(BASE + "/chat", { waitUntil: "networkidle0" }); await sleep(800);
    check("someone new is invited", (await count(fresh, ".invite")) === 1);
    const nav = fresh.waitForNavigation({ waitUntil: "networkidle0" }); await fresh.click(".invite .white"); await nav; await sleep(700);
    check("the invitation leads to /welcome", new URL(fresh.url()).pathname === "/welcome");
    await fresh.click("#next"); await sleep(800);
    await fresh.type("#f-name", "danny"); await fresh.click("#next"); await sleep(800);
    check("it uses the name straight away, capitalised", /Danny/.test(await text(fresh, "#card h1") ?? ""), await text(fresh, "#card h1"));
    check("the answer shows as saved, with its blob", (await count(fresh, ".rcpt.ok a")) === 1);
    for (const id of ["tutor", "coding"]) await fresh.click(`.chip[data-id="${id}"]`);
    await fresh.click("#next"); await sleep(800);
    check("picking coding offers the tools row", (await count(fresh, "#f-tools .chip")) > 5);
    await fresh.click('#f-length .chip[data-v="short"]'); await fresh.click('#f-tools .chip[data-v="pnpm"]');
    await fresh.click("#next"); await sleep(800);
    await fresh.click("#skip"); await sleep(1200);
    check("a step can be skipped", /apps/i.test(await text(fresh, ".kick") ?? ""), await text(fresh, ".kick"));
    check("a link code is offered", /^[A-Z0-9]{6}$/.test(await text(fresh, ".code b") ?? ""), await text(fresh, ".code b"));
    await fresh.click("#back"); await sleep(700);
    check("Back goes back", /picture/i.test(await text(fresh, ".kick") ?? ""));
    await fresh.click("#next"); await sleep(900); await fresh.click("#next"); await sleep(900);
    check("the last screen lists what it knows", (await count(fresh, "#know li.ok")) === 4, await count(fresh, "#know li.ok"));
    const nav2 = fresh.waitForNavigation({ waitUntil: "networkidle0" }); await fresh.click("#next"); await nav2; await sleep(800);
    check("it ends in the chat, greeted by name", new URL(fresh.url()).pathname === "/chat" && /Danny/.test(await text(fresh, ".welcome h2") ?? ""), await text(fresh, ".welcome h2"));
    check("starters match the jobs chosen", (await fresh.$$eval(".seed", (s) => s.map((x) => x.textContent))).some((t) => /debug/i.test(t)));
    check("and it is not offered again", (await count(fresh, ".invite")) === 0 && (await fresh.evaluate(() => localStorage.getItem("ws8-onboarded"))) === "done");
    check("no errors", ferrs.length === 0, ferrs.slice(0, 2));
    await fresh.close(); }

  /* ── arriving from another page ── */
  section("page transitions");
  { const { page, errors } = await open("/");
    // Measured in the first animation frame, not in the event itself: this
    // listener is registered before the page's own, so inside the event the
    // page has not yet had its turn to react to it.
    await page.evaluateOnNewDocument(() => addEventListener("pagereveal", (e) => { window.__vt = Boolean(e.viewTransition);
      requestAnimationFrame(() => { window.__first = { panel: [...document.querySelectorAll(".panel")].find((p) => !p.hidden)?.dataset.panel, chat: getComputedStyle(document.querySelector(".chat") ?? document.body).opacity }; }); }));
    const nav = page.waitForNavigation({ waitUntil: "load" }); await page.click('.actions a[href="/chat"]'); await nav; await sleep(300);
    const vt = await page.evaluate(() => ({ vt: window.__vt, first: window.__first }));
    check("landing → chat is a view transition", vt.vt === true);
    check("and the first frame is the finished page", vt.first?.panel === "chat" && vt.first?.chat === "1", vt.first);

    /* The button borrows its destination's view-transition-name so the two
       morph instead of cross-fading. It only works if three things line up:
       the name matches where the button actually points (a first visit opens
       the introduction, a return opens the chat), the arriving page stamps
       the root before its first frame, and the note is cleared afterwards so
       a later arrival by another route looks ordinary. Any one of those
       silently degrades to a plain fade, which is exactly the kind of thing
       nobody notices has stopped working. */
    const hero = await open("/chat", { store: { "ws8-user": "vt-hero-check" } });
    await hero.page.goto(BASE + "/", { waitUntil: "networkidle0" }); await sleep(600);
    const dest = await hero.page.$eval("#open", (a) => new URL(a.href).pathname);
    /* The orb carries the name now: everything on the page is pulled into it
       and it is the thing that becomes the panel, so the morph source is the
       mascot rather than the button that was pressed. */
    const borrowed = await hero.page.evaluate(() => {
      document.querySelector("#open").click();
      return document.getElementById("orb")?.style.viewTransitionName || "";
    });
    await sleep(1600);
    const landed = await hero.page.evaluate(() => ({
      url: location.pathname,
      stamped: document.documentElement.dataset.vt ?? null,
      cleared: !sessionStorage.getItem("vt.hero"),
    }));
    check("the orb borrows the name of where it actually goes",
      borrowed === (dest === "/welcome" ? "welcome-main" : "app-main"), `${dest} → ${borrowed || "(none)"}`);
    check("and the page it opens knows to morph rather than fade", landed.stamped === "hero", landed);
    check("and the note is cleared so the next arrival is ordinary", landed.cleared === true);

    /* Every quick control under the composer has to actually do something.
       `data-link` was written valueless, the way a boolean attribute is, so
       `dataset.link` was the empty string and the handler's truthiness test
       never fired: the button was wired, and silently did nothing on every
       click for as long as it existed. Checked by pressing each one. */
    const qc = await open("/chat", { store: { "ws8-user": "qc-check" } });
    await sleep(1400);
    const controls = await qc.page.$$eval(".qc", (bs) =>
      bs.filter((b) => b.id !== "newchat-q").map((b) => ({
        label: b.textContent.trim().slice(0, 28),
        wired: "ask" in b.dataset || "prefill" in b.dataset || "link" in b.dataset,
      })));
    check("every quick control is wired to something", controls.every((c) => c.wired),
      controls.filter((c) => !c.wired).map((c) => c.label));

    /* The control opens the linking panel — a code to type on another app and
       a QR that carries it — rather than saying anything in the chat. So this
       asserts the panel, not the log. */
    const linkBtn = await qc.page.$(".qc[data-link]");
    if (linkBtn) {
      await linkBtn.click();
      let panel = {};
      for (let i = 0; i < 30; i++) {
        panel = await qc.page.evaluate(() => ({
          open: document.getElementById("scrim")?.classList.contains("on") ?? false,
          code: (document.getElementById("codeval")?.firstChild?.nodeValue ?? "").trim(),
        }));
        if (panel.open && /^[A-Z0-9]{6}$/.test(panel.code)) break;
        await sleep(400);
      }
      check("the link control opens the linking panel", panel.open === true, panel);
      check("and the panel carries a real code", /^[A-Z0-9]{6}$/.test(panel.code), panel.code || "(none)");
    }
    await qc.page.close();

    /* Signing in with a wallet and seeing the page look exactly as it did
       before is indistinguishable from it having failed, which was most of why
       the flow felt broken even on the turns that worked. */
    const w = await open("/chat", { store: {
      "ws8-user": "sui-0xa3ca1333e08cf101f4bb2c9d77ee5510aa91c8f2dd41b6e7c3a55d9988776655",
      "ws8-wallet": "0xa3ca1333e08cf101f4bb2c9d77ee5510aa91c8f2dd41b6e7c3a55d9988776655",
    } });
    await sleep(900);
    const chip = await w.page.evaluate(() => {
      const el = document.getElementById("walletchip");
      return { shown: !!(el && !el.hidden), text: document.getElementById("walletchiptext")?.textContent ?? "" };
    });
    check("a signed-in wallet shows in the header", chip.shown, chip.text);
    check("shortened the way a wallet shortens it", /^0x\w{4}…\w{4}$/.test(chip.text), chip.text);
    await w.page.close();

    const plain = await open("/chat", { store: { "ws8-user": "no-wallet-here" } });
    await sleep(700);
    check("and stays out of the way when there is no wallet",
      await plain.page.evaluate(() => document.getElementById("walletchip")?.hidden !== false));
    await plain.page.close();

    /* On a phone the three ways in are docked to the bottom as one glass bar.
       In the flow they fell below the fold on a short screen, so the single
       thing this page asks you to do needed a scroll to reach. What breaks it
       is collision: the footer reading through the glass, or the docs button
       sharing the corner. Both happened. */
    const bar = await open("/", { width: 390, height: 740, store: null });
    await sleep(1600);
    await bar.page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await sleep(500);
    const docked = await bar.page.evaluate(() => {
      const a = document.querySelector(".actions");
      const r = a.getBoundingClientRect();
      const foot = document.querySelector(".foot")?.getBoundingClientRect();
      const fab = document.querySelector(".docs-fab");
      const hit = (x, y) => x && y && !(x.bottom < y.top || x.top > y.bottom || x.right < y.left || x.left > y.right);
      return {
        fixed: getComputedStyle(a).position === "fixed",
        onScreen: r.bottom <= innerHeight + 1 && r.top >= 0,
        oneRow: new Set([...a.children].map((e) => Math.round(e.getBoundingClientRect().top))).size === 1,
        clearOfFooter: !hit(r, foot),
        fabHidden: !fab || getComputedStyle(fab).display === "none",
      };
    });
    check("on a phone the ways in are docked to the bottom", docked.fixed && docked.onScreen, docked);
    check("as one row, not a stack", docked.oneRow);

    /* All three ways in have to be findable, and on a phone two of them lose
       their labels — which is how Danny came to say he could not see the
       Discord one at all. Stripped to a mark, a disc at `--soft` on `--glass`
       reads as decoration next to a white pill, so each takes its own colour.
       Checked as: on screen, big enough to hit, and not the same colour as
       its neighbour. */
    const ways = await bar.page.evaluate(() => {
      const one = (id) => {
        const e = document.getElementById(id);
        if (!e) return null;
        const r = e.getBoundingClientRect(), c = getComputedStyle(e);
        return {
          shown: c.display !== "none" && c.visibility !== "hidden" && r.width > 0,
          tappable: Math.min(r.width, r.height) >= 40,
          onScreen: r.right <= innerWidth + 1 && r.left >= 0 && r.bottom <= innerHeight + 1,
          colour: c.color,
          href: e.getAttribute("href"),
        };
      };
      return { tg: one("tg"), dc: one("dc") };
    });
    check("Telegram and Discord are both on the bar, not just the chat",
      ways.tg?.shown && ways.dc?.shown, ways);
    check("both are big enough to hit and fully on screen",
      ways.tg?.tappable && ways.tg?.onScreen && ways.dc?.tappable && ways.dc?.onScreen, ways);
    check("and the two marks are told apart by colour, not by shape alone",
      ways.tg?.colour !== ways.dc?.colour, ways);
    check("Discord points at a real invite",
      /^https:\/\/discord\.(gg|com)\//.test(ways.dc?.href ?? ""), ways.dc?.href);
    check("with the small print clear of the glass, not reading through it", docked.clearOfFooter);
    check("and nothing else sharing that corner", docked.fabHidden);

    /* The check above only ever looked at the bottom of the scroll, where the
       padding holds the footer clear, and it passed happily while the small
       print rode over the bar on the way down. Two separate things were wrong
       and only the second was visible.

       The bar was translucent at .62. Blur does not hide text — only the
       backdrop's own alpha does, and the blur is the first thing a browser
       drops without GPU compositing, so the alpha has to carry it alone.

       And the bar was not on top at all. It sits inside <main>, which carries
       a `view-transition-name` for the landing→chat morph; that makes <main> a
       stacking context, sealing the bar's z-index inside it, and <main> paints
       before its sibling <footer>. So the footer went over the bar at any
       alpha. Hit-testing is the only honest way to ask: scroll until the two
       overlap and see which one the browser puts on top. */
    const over = await bar.page.evaluate(async () => {
      const a = document.querySelector(".actions");
      const f = document.querySelector(".foot");
      const alpha = (c) => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return 0;
        const p = m[1].split(",").map((n) => parseFloat(n));
        return p.length > 3 ? p[3] : 1;
      };
      // Walk the scroll until the footer actually reaches the bar; on a tall
      // phone the page may not scroll at all, and then there is nothing to ask.
      // The probe has to land inside BOTH boxes — the bar is inset 12px from
      // the screen edge and the footer starts at the column's 20px padding, so
      // a point taken from the bar's own left edge misses the footer entirely
      // and the stack comes back without it, passing for the wrong reason.
      const max = document.documentElement.scrollHeight - innerHeight;
      let overlap = null;
      for (let i = 0; i <= 10 && !overlap; i++) {
        scrollTo(0, (max * i) / 10);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const ra = a.getBoundingClientRect(), rf = f.getBoundingClientRect();
        const top = Math.max(ra.top, rf.top), bottom = Math.min(ra.bottom, rf.bottom);
        const left = Math.max(ra.left, rf.left), right = Math.min(ra.right, rf.right);
        if (bottom - top > 6 && right - left > 6) {
          overlap = { y: Math.round(top + 3), x: Math.round(left + 3) };
        }
      }
      const stack = overlap
        ? document.elementsFromPoint(overlap.x, overlap.y).map((e) => e.className || e.tagName)
        : [];
      const barAt = stack.findIndex((c) => String(c).includes("actions") || String(c) === "go");
      const footAt = stack.findIndex((c) => String(c).includes("foot") || String(c).includes("tiny"));
      return {
        alpha: alpha(getComputedStyle(a).backgroundColor),
        scrolls: max > 20,
        tested: !!overlap,
        stack: stack.slice(0, 4),
        barOnTop: !overlap || (barAt !== -1 && (footAt === -1 || barAt < footAt)),
      };
    });
    check("the glass is opaque enough that nothing scrolls through it",
      over.alpha >= 0.9, over);
    /* Shipped once, and it is the bug Danny actually saw: the small print rode
       over the white Open-the-chat pill, and every scrim added to hide it
       landed on top of the bar for the same stacking reason. */
    check("and the bar stays on top of the page scrolling past it",
      over.barOnTop, over);
    await bar.page.close();

    await hero.page.close();
    check("no errors", errors.length === 0, errors.slice(0, 2));
    await page.close(); }
} catch (err) {
  failed++;
  console.log("FAIL  the run itself stopped — " + err.message.split("\n")[0]);
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);
