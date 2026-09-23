#!/usr/bin/env node
/**
 * Screenshot the running web console, so design changes are judged against what
 * the page actually looks like.
 *
 *   node tools/shot.mjs [outfile] [width] [height]
 *
 * PATH_=/chat  AS_USER=<id>  SEED_CHAT=1  SEED_TEXT="..."  SEED_WAIT=<ms>
 */
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [out = "shot.png", w = "1512", h = "950"] = process.argv.slice(2);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--force-color-profile=srgb", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: Number(w), height: Number(h), deviceScaleFactor: 2 });

// Optionally shoot as an existing person, so panels are shown populated rather
// than in their empty state.
if (process.env.AS_USER) {
  await page.evaluateOnNewDocument((id) => localStorage.setItem("ws8-user", id), process.env.AS_USER);
}
await page.goto("http://localhost:8080" + (process.env.PATH_ ?? "/"), { waitUntil: "networkidle2", timeout: 45000 });
// Let fonts, live panels and entry animations settle. Memory panels wait on a
// Walrus recall, so WAIT buys them time when shooting a populated state.
await new Promise((r) => setTimeout(r, Number(process.env.WAIT ?? 2500)));

if (process.env.CLICK) {
  for (const sel of process.env.CLICK.split("|")) {
    await page.evaluate((s) => document.querySelector(s)?.click(), sel);
    await new Promise((r) => setTimeout(r, Number(process.env.CLICK_WAIT ?? 1200)));
  }
}

if (process.env.SEED_CHAT) {
  await page.evaluate((msg) => {
    if (msg) {
      const input = document.getElementById("input");
      input.value = msg;
      document.getElementById("form").requestSubmit();
    } else {
      document.querySelector(".seed")?.click();
    }
  }, process.env.SEED_TEXT ?? "");
  await new Promise((r) => setTimeout(r, Number(process.env.SEED_WAIT ?? 22000)));
}

const clip = process.env.CLIP
  ? Object.fromEntries(["x", "y", "width", "height"].map((k, i) => [k, Number(process.env.CLIP.split(",")[i])]))
  : undefined;
await page.screenshot({ path: out, ...(clip ? { clip } : {}) });
await browser.close();
console.log("wrote", out);
