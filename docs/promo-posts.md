# Promo posts — Walrus Sessions 8

**Prize:** 5 × $100 for posting about **the session** in a third-party community
(subreddit, forum, newsletter). X and Sui/Walrus channels do not count.

Two constraints worth keeping in mind while editing these:

1. It must be about the **session**, not about Continuity. Each draft therefore
   leads with the problem and links the hackathon. Your project appears only as
   evidence that you actually did the thing.
2. Every venue below removes low-effort promo. The drafts are built to survive
   moderation by being worth reading on their own — which is also what a "best
   promo" judge would reward.

**Read each community's self-promotion rule before posting.** r/LocalLLaMA and
r/MachineLearning are the strictest. If an account has no history in a sub, a
link post will usually be removed; a text post that answers a real question
usually survives. Space these out over a few days rather than posting five in
one evening, which reads as a campaign from the outside and often is.

Session link to use throughout:
`https://www.deepsurge.xyz/hackathons/c0141a4a-21be-4009-bc63-7c168608c849`

---

## 1 — r/LocalLLaMA

*Text post. This crowd cares about mechanics and is allergic to marketing. Lead
with the failure, not the hackathon.*

**Title:** Spent three weeks on persistent chatbot memory. The hard part wasn't storage, it was telling "no memories" apart from "lookup failed"

There's a hackathon running right now on chatbots that remember across sessions and devices, which is what got me into this. What I didn't expect was where the difficulty actually sat.

Storing memories is easy. Retrieving them is easy. The thing that nearly killed my project is that a vector search returning zero results and a user who genuinely has no history look *identical* in the response.

Concretely: I ran fourteen identical queries, 800ms apart, against a namespace holding thirteen memories. I got `5 5 5 5 0 0 5 5 0 0 0 0 5 5`. Empty six times out of fourteen, no error, no flag, nothing in the logs.

Now think about what a chatbot does with that. Mine read a user's identity record, got an empty result, concluded it had never met them, and created a second identity for the same person. The storage was append-only, so newest-wins meant every later read returned the new empty one. Their four memories were still on disk and permanently unreachable.

What I'd tell anyone building this, regardless of which memory layer you use:

- Retry on empty, but only for keys you've already seen hold data. Retrying genuinely-empty keys is wasted load and will get you rate limited.
- Never use a semantic search as an existence check. "Have I seen this user?" needs an exact lookup, because a false negative there is unrecoverable rather than merely wrong.
- Make every write produce a receipt you can audit later. I only found the identity bug because writes were logged with their storage ids, so I could reconstruct what actually happened instead of guessing.

The session is Walrus Sessions 8, running to Oct 9, and it's specifically about this problem: https://www.deepsurge.xyz/hackathons/c0141a4a-21be-4009-bc63-7c168608c849

Curious whether people here handle the empty-vs-failed distinction differently. Most memory layers I looked at have the same gap, so I assume everyone's just retrying and hoping.

---

## 2 — r/AI_Agents

*Text post. More tolerant of project context. The cross-app angle is the hook.*

**Title:** If your agent runs in more than one place, "memory" is really an identity problem

I've been building an assistant that's reachable from a web chat, Telegram and Discord, sharing one memory store, for a hackathon on chatbots that remember. Going in, I thought the interesting work would be retrieval quality. It wasn't. It was deciding who the user *is*.

Three surfaces means three account systems. A Telegram user id, a Discord snowflake and a browser session are three different strings for one person, and none of them knows about the others. So before you can recall anything you have to answer "which human is this?", and that lookup has to be right every single time.

Mine wasn't, once. The identity read came back empty on a transient failure, the bot decided this was a new person, minted a fresh id, and orphaned everything stored under the old one. No error was raised, because an empty result is the *correct* answer for a genuinely new user. There is nothing to catch.

Two things fell out of fixing it that I'd apply to any multi-surface agent:

Identity lookups deserve different treatment from content lookups. A wrong content recall gives one bad answer. A wrong identity recall loses someone's entire history, permanently, and looks like success.

Linking accounts has to be explicit and user-driven. I used a short code: ask the bot on one surface, paste it on another. Trying to infer that two accounts are the same person from behaviour is how you merge two strangers' memories.

Session details, open until Oct 9: https://www.deepsurge.xyz/hackathons/c0141a4a-21be-4009-bc63-7c168608c849

How are others handling cross-platform identity? I went with explicit linking, but I'd be interested if anyone has found something that doesn't put the work on the user.

---

## 3 — r/LangChain

*Shorter. Framed around where memory abstractions stop being enough.*

**Title:** Conversation buffers aren't memory once the agent outlives the session

Most memory abstractions assume one process and one conversation. The buffer lives in the session, and when the session ends it's either serialised somewhere or lost.

That breaks the moment the same assistant is reachable from two places. A user tells it something in one app and asks about it in another, and the buffer that holds the answer belongs to a different process entirely. You end up needing a store that isn't owned by any one session, plus a way to decide that two accounts are the same person.

I've been doing this for a hackathon on cross-session, cross-device chatbot memory, and the part that surprised me is how much of the work is retrieval *honesty* rather than retrieval quality. A search that returns nothing because it failed, and a search that returns nothing because there's nothing there, come back identical. If your agent branches on "do I know this user", that ambiguity turns a transient blip into permanent data loss. I lost a test user's history to exactly that before I started retrying empty reads.

Worth a look if you're interested in the problem, runs to Oct 9: https://www.deepsurge.xyz/hackathons/c0141a4a-21be-4009-bc63-7c168608c849

---

## 4 — dev.to

*Longer form is fine here, and it can carry the article. Tag it `ai`, `webdev`,
`showdev`. This is the one place a build log is welcome.*

**Title:** What I learned building a chatbot that remembers you across three apps

Opening: there's a hackathon running until Oct 9 on chatbots that remember across sessions, users and devices. I entered it, and this is what the problem actually turned out to be, as opposed to what I expected.

Then reuse the structure of `docs/article-draft.md`, trimmed to about half
length, with the identity incident as the lede and the receipts rule as the
takeaway. Link the session, and link the full article once it's on Medium.

Don't post this one before the Medium article exists — cross-linking them is
most of the value, and dev.to readers follow through to longer pieces.

---

## 5 — Indie Hackers

*Build-in-public framing. Shortest of the five. This audience wants the
decision-making, not the code.*

**Title:** Shipping to three platforms at once was cheaper than I expected, and the reason is boring

I built an assistant reachable from a web chat, Telegram and Discord for a hackathon on chatbots with persistent memory, due Oct 9.

I expected three platforms to mean roughly three times the work. It didn't, and the reason is unglamorous: every surface calls exactly one function. Telegram's adapter converts an update into a message and hands it over. Discord's does the same. The web does the same. All the actual behaviour — recall, answer, store — lives in one place that knows nothing about any platform.

The upside showed up when I added features. Four conversational modes and file handling each went in once and appeared on all three surfaces the same afternoon. The cost of a fourth platform now is an adapter, which is maybe a hundred lines.

The thing I got wrong was assuming the storage layer was the risky part and the platform glue was routine. It was the reverse. Storage mostly worked; what bit me was a transient empty read convincing the bot it had never met a user, which silently orphaned that user's history. Nothing errored. I'd have shipped it without noticing if writes hadn't been producing auditable receipts.

Session, if the problem interests you: https://www.deepsurge.xyz/hackathons/c0141a4a-21be-4009-bc63-7c168608c849

---

## Venues deliberately not used

- **r/SuiNetwork and any Walrus community** — explicitly excluded by the rules.
- **X / Twitter** — excluded. The required X post is a separate submission item,
  not part of this prize.
- **r/MachineLearning** — self-promotion rules are strict enough that a hackathon
  mention would likely be removed, and a removed post earns nothing.
- **Hacker News** — possible, but "Show HN" is for the project rather than the
  session, and a hackathon link post tends to sink. If you want to try it, use it
  for the article after it's published rather than for the session.
