/**
 * Signing in to the website by tapping a number in Telegram.
 *
 * The old way was a six-character code carried by hand between two apps. It
 * worked, and nobody enjoyed it: `/link` on one surface, read the code, switch
 * app, type `/link ABC123`. Two surfaces, four steps, one chance to typo.
 *
 * This is the shape Google and Microsoft use for push sign-in, and it is
 * better for a reason worth stating. The website shows a number. Telegram
 * shows three numbers and asks which one. Getting it right proves you are
 * holding both ends at once, with one tap and nothing typed — and crucially
 * the person who started the sign-in cannot tell you which number to press,
 * because they never see the buttons.
 *
 * WHAT ACTUALLY MAKES IT SAFE
 *
 * Not the number. A blind guess is one in three, which is not security. Three
 * things carry it:
 *
 *   One attempt. A wrong tap fails the request outright, with no second go.
 *     Without this, three taps beats any number of options.
 *   A short life. Two minutes, so a link that leaks is almost always dead.
 *   A cap per account. Someone cannot push you fifty prompts hoping you tap
 *     one to make them stop, which is the attack the whole pattern exists for.
 *
 * And the prompt says whose browser it is and offers "Not me", because a
 * person who did not start this needs somewhere to put that fact. A
 * confirmation with only one button is a button people learn to press.
 *
 * In memory on purpose: a sign-in request is worthless ninety seconds after it
 * is made, and writing a list of who is signing in from where to a disk is a
 * liability with no upside.
 */

import { randomUUID, randomInt } from "node:crypto";

const TTL_MS = 2 * 60 * 1000;
const OPTIONS = 3;
/** How many prompts one Telegram account may be sent in an hour. */
const PER_ACCOUNT_HOURLY = 8;

const requests = new Map(); // id -> request
const pushes = new Map();   // surfaceUserId -> [timestamps]

const now = () => Date.now();

function sweep() {
  for (const [id, r] of requests) if (r.expiresAt < now()) requests.delete(id);
}

/** Two digits, like the ones in the prompt: big enough to read, small enough to say. */
const digit = () => randomInt(10, 100);

/**
 * Begin a sign-in. Called by the website, before anything knows who you are.
 *
 * `device` is shown in the prompt ("Chrome on Mac") and is the only thing a
 * person has to go on when deciding whether this was them. It comes from the
 * browser's own user agent and is never trusted for anything else.
 */
export function startSignIn({ device = "a web browser", webUserId = null } = {}) {
  sweep();
  const choices = new Set();
  while (choices.size < OPTIONS) choices.add(digit());
  const digits = [...choices];
  const correct = digits[randomInt(0, digits.length)];

  const id = randomUUID().replace(/-/g, "").slice(0, 22);
  requests.set(id, {
    id, digits, correct, device, webUserId,
    status: "pending",
    createdAt: now(),
    expiresAt: now() + TTL_MS,
    personId: null,
  });
  return { id, number: correct, expiresInSeconds: Math.round(TTL_MS / 1000) };
}

/** What the website polls. Never reveals the answer, only the outcome. */
export function signInStatus(id) {
  sweep();
  const r = requests.get(id);
  if (!r) return { status: "expired" };
  return { status: r.status, personId: r.status === "approved" ? r.personId : null };
}

/**
 * The prompt Telegram should draw, or why it should not.
 *
 * The rate limit is checked here rather than when the website asks, because
 * the thing being protected is the person's Telegram, not the website's
 * endpoint: the cost of abuse is a stranger's phone buzzing eight times.
 */
export function openSignIn(id, surfaceUserId) {
  sweep();
  const r = requests.get(id);
  if (!r) return { ok: false, reason: "expired" };
  if (r.status !== "pending") return { ok: false, reason: r.status };

  const seen = (pushes.get(surfaceUserId) ?? []).filter((t) => t > now() - 60 * 60 * 1000);
  if (seen.length >= PER_ACCOUNT_HOURLY) return { ok: false, reason: "too-many" };
  pushes.set(surfaceUserId, [...seen, now()]);

  r.openedBy = surfaceUserId;
  return { ok: true, digits: r.digits, device: r.device };
}

/**
 * A tapped number.
 *
 * One attempt, whatever happens. A wrong answer does not say which was right
 * and does not allow another, because the alternative is that three taps beat
 * any number of options.
 */
export function answerSignIn(id, choice, { personId, surfaceUserId } = {}) {
  sweep();
  const r = requests.get(id);
  if (!r) return { ok: false, reason: "expired" };
  if (r.status !== "pending") return { ok: false, reason: r.status };
  // The prompt must have been opened by whoever is answering it.
  if (r.openedBy && surfaceUserId && r.openedBy !== surfaceUserId) {
    return { ok: false, reason: "wrong-account" };
  }

  if (Number(choice) !== r.correct) {
    r.status = "wrong";
    return { ok: false, reason: "wrong" };
  }
  r.status = "approved";
  r.personId = personId ?? null;
  return { ok: true, personId: r.personId, webUserId: r.webUserId };
}

/** "Not me." The request dies and says so to the browser that started it. */
export function denySignIn(id) {
  const r = requests.get(id);
  if (!r || r.status !== "pending") return false;
  r.status = "denied";
  return true;
}

/** Read a Telegram user agent into something a person recognises. */
export function describeDevice(ua) {
  const s = String(ua ?? "");
  if (!s) return "a web browser";
  const browser =
    /\bEdg\//.test(s) ? "Edge"
    : /\bOPR\/|\bOpera/.test(s) ? "Opera"
    : /\bChrome\//.test(s) ? "Chrome"
    : /\bFirefox\//.test(s) ? "Firefox"
    : /\bSafari\//.test(s) ? "Safari"
    : "a browser";
  const os =
    /\bAndroid\b/.test(s) ? "Android"
    : /\biPhone\b/.test(s) ? "iPhone"
    : /\biPad\b/.test(s) ? "iPad"
    : /\bMac OS X\b|\bMacintosh\b/.test(s) ? "Mac"
    : /\bWindows\b/.test(s) ? "Windows"
    : /\bLinux\b/.test(s) ? "Linux"
    : null;
  return os ? `${browser} on ${os}` : browser;
}

export const stats = () => ({ pending: [...requests.values()].filter((r) => r.status === "pending").length });
