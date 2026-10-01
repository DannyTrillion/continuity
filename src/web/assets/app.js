/**
 * The small amount of behaviour all three sections share.
 *
 * Two things here, both about the moment right after you click a tab.
 *
 * First, nothing is fetched twice. The history page asked the server for your
 * conversations once to draw the list and again to put a count on the nav pill
 * — two Walrus round trips for one answer, on a relayer with a sixty requests
 * per minute ceiling. Requests are now shared for the life of the page.
 *
 * Second, a page paints with what it knew a moment ago instead of an empty
 * panel. Reading from Walrus takes a few seconds, and staring at "Reading from
 * Walrus…" every single time you switch tabs is what made this feel broken
 * rather than slow. The cached answer goes up immediately and is replaced when
 * the real one lands — and only if it actually differs, so nothing flickers.
 *
 * The cache is sessionStorage, not localStorage, on purpose: it lasts exactly
 * as long as the tab is open, which covers moving between sections, and leaves
 * nothing of someone's memories on disk afterwards.
 */

const WS8 = (() => {
  const who = (() => {
    try { return localStorage.getItem("ws8-user"); } catch { return null; }
  })();

  /* ── one request per endpoint, shared by every caller ───────────────── */

  const inflight = new Map();

  /**
   * Share one request per endpoint. `fresh` forces a new one and replaces the
   * shared copy — the chat page re-reads memory after every turn, and handing
   * it the answer from page load would show a memory that is one turn stale.
   */
  function api(path, { fresh = false } = {}) {
    if (fresh || !inflight.has(path)) {
      inflight.set(path, fetch(path).then((r) => r.json()).catch((err) => ({ error: err.message })));
    }
    return inflight.get(path);
  }

  const memories = (opts) =>
    who ? api("/api/memory?userId=" + encodeURIComponent(who), opts) : Promise.resolve({ facts: [] });

  const conversations = (opts) =>
    who ? api("/api/conversations?userId=" + encodeURIComponent(who), opts) : Promise.resolve({ conversations: [] });

  /* ── last known good, so a section opens with something in it ───────── */

  const slot = (name) => `ws8-cache:${name}:${who ?? "anon"}`;

  /**
   * Entries carry the time they were stored, because how old an answer is
   * decides whether it is worth asking again. The relayer allows sixty
   * requests a minute across the whole account, and moving between three
   * sections was spending two reads per page on the nav counts alone —
   * enough that clicking around quickly rate-limited the person doing it.
   */
  function entry(name) {
    if (!who) return null;
    try {
      const raw = sessionStorage.getItem(slot(name));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && "v" in parsed ? parsed : { at: 0, v: parsed };
    } catch {
      return null; // private window, or storage disabled; just skip the shortcut
    }
  }

  const cached = (name) => entry(name)?.v ?? null;
  const age = (name) => { const e = entry(name); return e ? Date.now() - e.at : Infinity; };

  function remember(name, value) {
    if (!who) return;
    try { sessionStorage.setItem(slot(name), JSON.stringify({ at: Date.now(), v: value })); } catch { /* not important enough to fail over */ }
  }

  /* How long an answer is treated as still true. Long enough that moving
     between sections costs nothing, short enough that a memory you just added
     shows up when you go looking for it. The chat page bypasses this after
     every turn, which is when the answer has actually changed. */
  const FRESH_MS = 20_000;

  /**
   * Paint immediately from cache, then again from the network — but only if the
   * answer actually changed. Re-rendering identical content would restart every
   * entry animation on the page for no reason, which looks like a flicker.
   */
  async function live(name, fetcher, draw) {
    const seen = cached(name);
    if (seen !== null) draw(seen, { fromCache: true });

    // Recent enough to trust. Skipping the read is what makes going back and
    // forth between sections instant rather than merely quick.
    if (seen !== null && age(name) < FRESH_MS) return;

    const fresh = await fetcher();
    if (fresh?.error) return seen === null ? draw(fresh, { fromCache: false }) : undefined;

    if (JSON.stringify(fresh) !== JSON.stringify(seen)) draw(fresh, { fromCache: false });
    remember(name, fresh);
  }

  /* ── saying what went wrong ──────────────────────────────────────────── */

  /**
   * Turn a server error into something a person can act on.
   *
   * These used to go on screen verbatim, so hitting the relayer's rate limit
   * printed a raw JSON body — layer names, weighted-request counts, the lot —
   * across the middle of the page. Whatever that communicates, it is not what
   * happened or what to do about it.
   */
  function explain(message) {
    const text = String(message ?? "");
    if (/rate limit|too many requests|429/i.test(text)) {
      const secs = Number(text.match(/retry_after_seconds"?\s*:\s*(\d+)/)?.[1]);
      const wait = !secs ? "about a minute"
        : secs >= 60 ? `about ${Math.round(secs / 60)} minute${secs >= 120 ? "s" : ""}`
        : `about ${secs} seconds`;
      return `Busy right now — too many requests at once. Nothing is lost; try again in ${wait}.`;
    }
    if (/failed to fetch|networkerror|network|offline/i.test(text)) {
      return "Couldn't reach the server. Check your connection and try again.";
    }
    if (/timeout|timed out/i.test(text)) return "That took too long to come back. Try again in a moment.";
    return "Couldn't read that just now. Nothing is lost — try again in a moment.";
  }

  /** A failure the person can do something about, rather than a dead end. */
  function problem(el, message, retry) {
    if (!el) return;
    el.innerHTML = `<p class="empty">${explain(message)}${retry ? ' <button class="again" type="button">Try again</button>' : ""}</p>`;
    if (retry) el.querySelector(".again")?.addEventListener("click", retry, { once: true });
  }

  /* ── the nav pills ───────────────────────────────────────────────────── */

  function nav() {
    const here = location.pathname.replace(/\.html$/, "") || "/chat";
    for (const a of document.querySelectorAll(".nav a")) {
      a.classList.toggle("on", a.getAttribute("href") === here);
    }
    if (!who) return;

    // Counts from cache first. These used to arrive with the network and flip
    // from hidden to visible, nudging the whole bar sideways a second after
    // the page had settled.
    const badge = (id, n) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (n) { el.textContent = n; el.hidden = false; } else { el.hidden = true; }
    };

    const mem = cached("memory"), convos = cached("conversations");
    if (mem) badge("nav-mem", mem.facts?.length);
    if (convos) badge("nav-hist", convos.conversations?.length);

    // A count is the least important thing on the page. It is never worth
    // spending a read on when a recent one is already in hand.
    if (age("memory") >= FRESH_MS) {
      memories().then((m) => { if (!m.error) { badge("nav-mem", m.facts?.length); remember("memory", m); } }).catch(() => {});
    }
    if (age("conversations") >= FRESH_MS) {
      conversations().then((c) => { if (!c.error) { badge("nav-hist", c.conversations?.length); remember("conversations", c); } }).catch(() => {});
    }
  }

  return { who, api, memories, conversations, cached, age, remember, live, nav, explain, problem, FRESH_MS };
})();
