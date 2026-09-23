/**
 * Reading the web: fetch a page, search, take a screenshot.
 *
 * Everything here is reachable by anyone who can message the bot, so every URL
 * is checked before it is opened. A bot that fetches whatever a stranger sends
 * is a door into whatever network it runs on — cloud metadata endpoints, admin
 * panels on localhost, anything on the private side of the firewall.
 *
 * Whatever comes back is DATA. It is fenced as such in the prompt and never
 * treated as instructions, because a page can say anything it likes.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 2_000_000;
const MAX_TEXT = 6_000;

/** Private, loopback, link-local and carrier-grade NAT ranges. */
function isPrivateIp(ip) {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") ||
      v.startsWith("fe80") || v.startsWith("::ffff:");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||          // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export async function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return { ok: false, reason: "That doesn't look like a web address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "I can only open http and https links." };
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    return { ok: false, reason: "That address is on a private network." };
  }
  try {
    // Resolve first: a public-looking hostname can still point somewhere private.
    const ips = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!ips.length || ips.some((r) => isPrivateIp(r.address))) {
      return { ok: false, reason: "That address is on a private network." };
    }
  } catch {
    return { ok: false, reason: "I couldn't resolve that address." };
  }
  return { ok: true, url };
}

const decode = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
    if (e[0] === "#") return String.fromCodePoint(parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10));
    return named[e.toLowerCase()] ?? m;
  });

/** Strip a page down to something a model can actually read. */
function readable(html) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim()).slice(0, 200);
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body).replace(/[ \t ]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  return { title, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
}

/** Fetch one page and return its readable text. */
export async function readPage(raw) {
  const checked = await checkUrl(raw);
  if (!checked.ok) return { ok: false, error: checked.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(checked.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Identify honestly. Some sites block unknown agents outright.
        "User-Agent": "ContinuityBot/1.0 (+https://walrus.xyz)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
      },
    });
    if (!res.ok) return { ok: false, error: `That page returned ${res.status}.` };

    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      return { ok: false, error: `That link is a ${type.split(";")[0] || "file"}, not a page I can read.` };
    }

    // Read with a cap rather than trusting content-length.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let bytes = 0;
    while (bytes < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});

    const { title, text, truncated } = readable(html);
    if (!text) return { ok: false, error: "That page had nothing readable on it." };
    return { ok: true, url: checked.url.href, title, text, truncated };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "That page took too long to load." : "I couldn't reach that page." };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Web search.
 *
 * Brave's API when a key is set (free tier covers 2,000 queries a month), and
 * DuckDuckGo's instant answers otherwise — which only knows encyclopedic
 * topics, so it is a fallback, not a search engine.
 *
 * Scraping DuckDuckGo's HTML was the first attempt and it does not work: they
 * answer scripted requests with a 202 and a challenge page. Rather than let
 * that look like "no results", searching says plainly when it is unconfigured.
 */
export const searchConfigured = () => Boolean(process.env.BRAVE_API_KEY);

async function braveSearch(query, limit, signal) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", String(query).slice(0, 300));
  url.searchParams.set("count", String(Math.min(limit, 10)));
  const res = await fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": process.env.BRAVE_API_KEY,
    },
  });
  if (!res.ok) return { ok: false, error: `Search returned ${res.status}.` };
  const json = await res.json();
  const results = (json?.web?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: (r.description ?? "").replace(/<[^>]+>/g, ""),
  }));
  return results.length ? { ok: true, results } : { ok: false, error: "Nothing came back for that." };
}

async function instantAnswer(query, signal) {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", String(query).slice(0, 300));
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  const res = await fetch(url, { signal });
  if (!res.ok) return { ok: false, error: `Search returned ${res.status}.` };
  const j = await res.json();
  const results = [];
  if (j.AbstractText) {
    results.push({ title: j.Heading || query, url: j.AbstractURL, snippet: j.AbstractText });
  }
  for (const t of j.RelatedTopics ?? []) {
    if (results.length >= 4) break;
    if (t.Text && t.FirstURL) results.push({ title: t.Text.split(" - ")[0], url: t.FirstURL, snippet: t.Text });
  }
  return results.length
    ? { ok: true, results, weak: true }
    : { ok: false, error: "I can't search the web here — no search key is configured. Send me a link and I'll read it." };
}

export async function searchWeb(query, { limit = 5 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return searchConfigured()
      ? await braveSearch(query, limit, controller.signal)
      : await instantAnswer(query, controller.signal);
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "Search timed out." : "Search failed." };
  } finally {
    clearTimeout(timer);
  }
}

/* ── screenshots ────────────────────────────────────────────────────────── */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

let browserPath;
async function findBrowser() {
  if (browserPath !== undefined) return browserPath;
  const { existsSync } = await import("node:fs");

  browserPath = CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
  if (browserPath) return browserPath;

  // Nix-based builders (Railway's nixpacks among them) put chromium in the nix
  // store rather than /usr/bin, so ask PATH before giving up.
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
      const { stdout } = await promisify(execFile)("which", [name]).catch(() => ({ stdout: "" }));
      const found = stdout.trim();
      if (found && existsSync(found)) return (browserPath = found);
    }
  } catch { /* no shell, or nothing found */ }

  return browserPath;
}

/**
 * Screenshot a page. Returns a PNG buffer, or an explanation.
 * Needs a Chrome on the host — set CHROME_PATH where that isn't standard.
 */
export async function screenshotUrl(raw, { width = 1280, height = 800, fullPage = false } = {}) {
  const checked = await checkUrl(raw);
  if (!checked.ok) return { ok: false, error: checked.reason };

  const exe = await findBrowser();
  if (!exe) return { ok: false, error: "I can't take screenshots here — no browser installed on this server." };

  let browser;
  try {
    const puppeteer = (await import("puppeteer-core")).default;
    browser = await puppeteer.launch({
      executablePath: exe,
      headless: "new",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(checked.url.href, { waitUntil: "networkidle2", timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 900)); // let fonts and lazy images settle
    const png = await page.screenshot({ type: "png", fullPage });
    return { ok: true, png, url: checked.url.href };
  } catch (err) {
    return { ok: false, error: err.name === "TimeoutError" ? "That page took too long to load." : "I couldn't screenshot that page." };
  } finally {
    await browser?.close().catch(() => {});
  }
}
