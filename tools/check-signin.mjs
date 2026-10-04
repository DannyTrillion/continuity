#!/usr/bin/env node
/**
 * Signing in by tapping a number.
 *
 *   node tools/check-signin.mjs
 *
 * This is auth, so the checks are about what must NOT work. A happy path that
 * passes while a wrong guess also passes is worse than no sign-in at all: it
 * looks like a lock. Nothing here touches Walrus or the network.
 */
import { readFileSync } from "node:fs";
import {
  startSignIn, signInStatus, openSignIn, answerSignIn, denySignIn, describeDevice,
} from "../src/core/signin.mjs";

let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  const said = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${said ? ` — ${said}` : ""}`);
};
const section = (t) => console.log(`\n── ${t}`);

section("the number itself");
{
  const a = startSignIn({ device: "Chrome on Mac" });
  const open = openSignIn(a.id, "tg-1");
  check("the browser is told one number", typeof a.number === "number", a.number);
  check("it is two digits, so it reads on a phone", a.number >= 10 && a.number <= 99, a.number);
  check("Telegram is shown three", open.digits.length === 3, open.digits);
  check("the right one is among them", open.digits.includes(a.number));
  check("they are all different, or two buttons would both be right",
    new Set(open.digits).size === 3, open.digits);
  check("and the device is passed through for the person to judge",
    open.device === "Chrome on Mac", open.device);
}

section("one attempt, and that is what makes it a lock");
{
  const a = startSignIn({});
  openSignIn(a.id, "tg-1");
  const wrong = [10, 11, 12, 13].find((n) => n !== a.number);
  const first = answerSignIn(a.id, wrong, { personId: "p1", surfaceUserId: "tg-1" });
  check("a wrong number fails", first.ok === false, first.reason);
  const second = answerSignIn(a.id, a.number, { personId: "p1", surfaceUserId: "tg-1" });
  check("and the RIGHT number afterwards still fails", second.ok === false, second.reason);
  check("the browser is told it went wrong, not left waiting",
    signInStatus(a.id).status === "wrong", signInStatus(a.id).status);
}

section("the ordinary path");
{
  const a = startSignIn({});
  openSignIn(a.id, "tg-7");
  check("pending until somebody taps", signInStatus(a.id).status === "pending");
  const out = answerSignIn(a.id, a.number, { personId: "person-7", surfaceUserId: "tg-7" });
  check("the right number approves it", out.ok === true, out.reason);
  check("and carries the person it belongs to", out.personId === "person-7", out.personId);
  check("the browser can now read that person", signInStatus(a.id).personId === "person-7");
  check("but only once it is approved",
    signInStatus(startSignIn({}).id).personId === null);
}

section("a request is single use");
{
  const a = startSignIn({});
  openSignIn(a.id, "tg-2");
  answerSignIn(a.id, a.number, { personId: "p2", surfaceUserId: "tg-2" });
  const again = answerSignIn(a.id, a.number, { personId: "attacker", surfaceUserId: "tg-2" });
  check("approving twice does not work", again.ok === false, again.reason);
  check("and cannot be repointed at somebody else",
    signInStatus(a.id).personId === "p2", signInStatus(a.id).personId);
}

section("not me");
{
  const a = startSignIn({});
  openSignIn(a.id, "tg-3");
  check("turning it down works", denySignIn(a.id) === true);
  check("the browser hears denied, not expired", signInStatus(a.id).status === "denied");
  check("and the number no longer approves anything",
    answerSignIn(a.id, a.number, { personId: "p3", surfaceUserId: "tg-3" }).ok === false);
  check("turning down a dead request changes nothing", denySignIn(a.id) === false);
}

section("one account cannot be buried in prompts");
{
  const victim = "tg-victim";
  const made = Array.from({ length: 12 }, () => startSignIn({}));
  const opened = made.map((r) => openSignIn(r.id, victim));
  const allowed = opened.filter((o) => o.ok).length;
  check("the prompts stop well short of twelve", allowed <= 8, `${allowed} sent`);
  check("and the refusal says why", opened.at(-1).reason === "too-many", opened.at(-1).reason);
  /* The cap is per account, so somebody else signing in is unaffected — a
     shared cap would let one attacker lock everyone else out. */
  const other = startSignIn({});
  check("somebody else is not locked out by it", openSignIn(other.id, "tg-bystander").ok === true);
}

section("an unknown id is not an open door");
{
  check("a made-up id cannot be approved",
    answerSignIn("0".repeat(22), 42, { personId: "p" }).ok === false);
  check("a made-up id reads as expired", signInStatus("0".repeat(22)).status === "expired");
  const a = startSignIn({});
  openSignIn(a.id, "tg-owner");
  check("and a prompt opened by one account cannot be answered by another",
    answerSignIn(a.id, a.number, { personId: "p", surfaceUserId: "tg-someone-else" }).ok === false);
}

section("the browser line people are asked to judge");
{
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
  check("Chrome on a Mac", describeDevice(mac) === "Chrome on Mac", describeDevice(mac));
  const iph = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  check("Safari on an iPhone", describeDevice(iph) === "Safari on iPhone", describeDevice(iph));
  check("and nothing at all still reads as a sentence",
    describeDevice("") === "a web browser", describeDevice(""));
}

section("signing in must not orphan what the browser already said");

/* The worst outcome here is not a failed sign-in. It is a successful one that
   drops the id a browser was using, because every memory written under that id
   becomes unreachable with nothing pointing at it and no error anywhere. That
   has happened in this codebase once. So the merge lives in ONE function and
   both ways of linking go through it. */
{
  const identity = readFileSync("src/core/identity.mjs", "utf8");
  const server = readFileSync("src/server.mjs", "utf8");
  check("there is a single adoptPerson, not a copy per caller",
    /export async function adoptPerson\(/.test(identity));
  check("redeeming a code goes through it",
    /redeemLinkCode[\s\S]{0,900}await adoptPerson\(/.test(identity));
  check("and so does signing in",
    /signin\/status[\s\S]{0,700}adoptPerson\(/.test(server));
  check("it keeps the old id rather than replacing it",
    /mergedFrom = \[\.\.\.new Set\(\[current\.personId/.test(identity));
  /* A browser that has said nothing has no id worth keeping, and adopting
     should be a no-op rather than writing an identity record for nobody. */
  check("adopting the person you already are is recognised as such",
    /if \(current\.personId === personId\) return[\s\S]{0,120}alreadyLinked: true/.test(identity));
}

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);
