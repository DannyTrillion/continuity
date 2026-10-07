import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-sandbox", "--force-device-scale-factor=2"],
});
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 675, deviceScaleFactor: 2 });
await p.goto("file://" + process.cwd() + "/card.html", { waitUntil: "networkidle0" });
await p.evaluateHandle("document.fonts.ready");
await new Promise(r => setTimeout(r, 900));
const el = await p.$(".card");
await el.screenshot({ path: "continuity-card.png" });
const bad = await p.evaluate(() => [...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.src));
console.log("broken images:", bad.length ? bad : "none");
await b.close();
