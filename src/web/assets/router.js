/**
 * Moving between sections without leaving the page.
 *
 * Chat, memory and history are three panels in one document now. Switching
 * shows one and hides another — the header is never replaced, nothing is
 * re-parsed, no script re-runs, and a panel you have already opened keeps
 * everything: your scroll position, what you had typed, the conversation.
 *
 * The URLs are real. /memory is still /memory, the back button still works,
 * and the links still say where they go, so a middle-click or a copied link
 * behaves like a link should. Only the in-page click is intercepted.
 *
 * A panel's data is read the first time it is opened and not before. Loading
 * all three up front would spend three Walrus reads to show one section.
 */

/* Panels register here. Declared before their scripts run, which is why this
   file is loaded first. */
window.PANELS = window.PANELS || {};

const Router = (() => {
  const PATH = { chat: "/chat", memory: "/memory", history: "/history" };
  const NAME = { "/chat": "chat", "/memory": "memory", "/history": "history" };
  const TITLE = {
    chat: "Continuity — the assistant that remembers you",
    memory: "Your memory — Continuity",
    history: "Past conversations — Continuity",
  };

  const opened = new Set();
  const scrolled = {};
  let current = null;

  const panel = (name) => document.getElementById(`p-${name}`);
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /**
   * Move the white pill to sit under whichever tab is active.
   *
   * It is one element that travels, not a background handed between tabs. The
   * width has to be measured rather than assumed because the tabs carry counts
   * that arrive later and change how wide they are — "Memory 10" is wider than
   * "Memory", and the pill has to still fit it.
   */
  let placed = false;
  function glide() {
    const bar = document.querySelector(".nav");
    const dot = document.getElementById("glide");
    const on = bar?.querySelector("a.on");
    if (!bar || !dot) return;

    // History has no pill of its own any more — it is reached from the rail.
    // With nothing to sit under, the pill fades out rather than stranding
    // itself under whichever tab happened to be last.
    if (!on) { dot.style.opacity = "0"; return; }

    // The first placement must not animate, or the pill slides in from the
    // left edge every time the page loads.
    if (!placed) dot.classList.add("placing");

    dot.style.width = `${on.offsetWidth}px`;
    dot.style.transform = `translateX(${on.offsetLeft - 4}px)`;
    dot.style.opacity = "1";
    bar.classList.add("glided");

    if (!placed) {
      placed = true;
      requestAnimationFrame(() => requestAnimationFrame(() => dot.classList.remove("placing")));
    }
  }

  function swap(name) {
    // Where you were in the section you are leaving, so coming back puts you
    // there rather than at the top.
    if (current) {
      const leaving = panel(current);
      if (leaving) scrolled[current] = leaving.scrollTop;
    }

    // Set every panel, not just the two involved. On the very first swap there
    // is no previous panel to hide, so a deep link to /history used to reveal
    // it underneath the chat panel that was already showing.
    for (const p of document.querySelectorAll(".panel")) p.hidden = p.dataset.panel !== name;

    const arriving = panel(name);
    arriving.scrollTop = scrolled[name] ?? 0;
    current = name;

    /**
     * Stage the contents in rather than cross-fading the panel.
     *
     * A cross-fade of the whole section only ever reads as one page replacing
     * another. Showing the section immediately and rising its contents in on
     * a stagger reads as the section opening — which is the difference
     * between navigating and browsing.
     *
     * The class comes off when the last child finishes so nothing is left
     * carrying an animation, and re-adding it next time restarts it cleanly.
     */
    /**
     * The staged rise is for the first time a section opens — that is when
     * its contents are actually arriving. Re-running it on every switch made
     * a section you had already seen vanish and rebuild itself, which read as
     * a blink. Coming back to one now is a short, soft fade of the whole
     * panel: it was there, it is there again.
     */
    if (!still()) {
      const firstOpen = !opened.has(name);
      arriving.classList.remove("opening", "returning");
      void arriving.offsetWidth; // restart the animation rather than resume it
      arriving.classList.add(firstOpen ? "opening" : "returning");
      clearTimeout(arriving._riseTimer);
      arriving._riseTimer = setTimeout(() => arriving.classList.remove("opening", "returning"), firstOpen ? 1100 : 460);
    }

    for (const a of document.querySelectorAll(".nav a")) {
      a.classList.toggle("on", a.getAttribute("href") === PATH[name]);
    }
    glide();
    document.title = TITLE[name] ?? document.title;

    // First open reads its data; every open after that is already on screen.
    if (!opened.has(name)) {
      opened.add(name);
      try { window.PANELS[name]?.open?.(); } catch (err) { console.error(`[router] ${name} failed to open:`, err); }
    }
  }

  function show(name, { push = true, search = "" } = {}) {
    if (!PATH[name] || name === current) {
      // Already here — but opening a conversation from the rail is still a
      // move worth recording. The URL names which one is open, so it can be
      // linked, bookmarked and stepped back out of.
      if (search) {
        if (push) history.pushState({ panel: name }, "", PATH[name] + search);
        openConversation(search);
      }
      return;
    }
    if (push) history.pushState({ panel: name }, "", PATH[name] + search);

    // No view transition here on purpose. The panel's contents staging
    // themselves in is the transition; cross-fading the whole section as well
    // was motion on top of motion, and that doubling is what read as slow.
    swap(name);
    if (search) openConversation(search);
  }

  /** A conversation link carries ?convo=… and means "open chat, on that one". */
  function openConversation(search) {
    const id = new URLSearchParams(search).get("convo");
    if (id && typeof window.__reopen === "function") window.__reopen(id);
  }

  function start() {
    // Deep links land on the right panel: the server serves this same document
    // for all three paths, so the path is what decides the opening section.
    const first = NAME[location.pathname] ?? "chat";
    swap(first);
    openConversation(location.search);

    // Arriving through a cross-document view transition, the browser is
    // already animating this page in. The staged rise on top of that started
    // every element at opacity 0 for the transition's snapshot, so the old
    // page dissolved into an empty one. `pagereveal` fires after this script
    // and before the first frame: drop the stagger, show the section finished.
    addEventListener("pagereveal", (e) => {
      if (!e.viewTransition) return;
      const arriving = panel(first);
      if (!arriving) return;
      clearTimeout(arriving._riseTimer);
      arriving.classList.remove("opening");
    });

    // One delegated handler covers every in-app link — the nav pills, "See all
    // of it", the footers, and each conversation in the list.
    document.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest("a[href]");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;

      const url = new URL(a.getAttribute("href"), location.origin);
      if (url.origin !== location.origin) return;
      const name = NAME[url.pathname];
      if (!name) return; // anything else — the landing page, say — navigates normally

      e.preventDefault();
      show(name, { search: url.search });
    });

    addEventListener("popstate", () => {
      const name = NAME[location.pathname] ?? "chat";
      if (name !== current) swap(name);
      openConversation(location.search);
    });

    // Counts on the pills, once, from the shared cache.
    if (window.WS8) WS8.nav();

    // A count appearing makes its tab wider, so the pill is re-measured
    // whenever the bar changes size or the window does. Without this it keeps
    // the width it had before "Memory" became "Memory 10".
    const bar = document.querySelector(".nav");
    if (bar && window.ResizeObserver) new ResizeObserver(() => glide()).observe(bar);
    addEventListener("resize", glide);
    // Webfonts land after first paint and shift the text width with them.
    if (document.fonts?.ready) document.fonts.ready.then(glide).catch(() => {});
  }

  return { start, show };
})();
