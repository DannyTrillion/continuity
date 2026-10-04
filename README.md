# One memory, three chat surfaces

A support chatbot that remembers you on the web, on Telegram and on Discord —
because all three read and write the same memory on **Walrus mainnet**.

Built for **Walrus Sessions 8: Chatbots That Remember** (Sept 18 – Oct 9, 2026).
Runs on open-weight models via OpenRouter (Kimi K2.5, DeepSeek v3.2 fallback) — no
Claude, no GPT.

## The idea

Most "chatbot with memory" demos remember you within one app. Move to another
device or another platform and you are a stranger again, because the memory was
never really *yours* — it was a row in that app's database.

Here, memory is a set of blobs on Walrus, keyed to a person rather than to a
surface. Type `/link` on Discord, redeem the code on Telegram, and the two
accounts collapse into one person who is remembered in both places. Nothing is
copied between them; the namespaces are simply read together.

## Try it

| Surface | Where |
| --- | --- |
| Web chat | _(deploy URL)_ |
| Telegram | _(@bot)_ |
| Discord | _(invite)_ |

Then: tell it something on one surface, `/link` to another, and ask it there.

## Commands

| Command | What it does |
| --- | --- |
| `/menu` | The things it does most, as buttons |
| `/link` | Issue a 6-character code (valid 10 minutes) |
| `/link CODE` | Redeem a code from another surface |
| `/whatyouknow` | List what it remembers about you |
| `/search WORDS`, `/shot URL` | Look something up, or screenshot a page |
| `/forgetme confirm` | Stop recording and stop reading you back |
| `/remember me` | Undo the above |

The list itself lives in one place (`MENU_COMMANDS` in
`src/core/commands.mjs`) and both adapters build their menus from it. They
used to keep a copy each, which is how `/mode` came to be registered with
neither of them while working perfectly if you typed it. `tools/check-bots.mjs`
now fails if Discord stops offering something the shared menu lists.

### Buttons, not memorised commands

A bot whose abilities are invisible until you read its help is a blank box
that happens to accept slashes. So a reply that has an obvious next step
carries it as a button: *What do you know about me?* after `/help`, *Connect
another app* after a link code, *See everything I remember* — a link straight
to the memory page — after a list of facts.

The actions are **named once** in `src/core/commands.mjs` and drawn by each
surface in its own idiom: Telegram makes an inline keyboard, Discord a row of
components, and either can carry a link button. A command added to that
registry becomes a button on both bots without either adapter changing, which
is what stops the three surfaces drifting apart.

A tapped button runs the command it stands for through exactly the same path
as typing it: same memory, same writes, same streaming. The button is a
shortcut for the person, never a shortcut in the code — and `/forgetme` keeps
its two-step confirmation on both bots, because a destructive thing one tap
away is a destructive thing done by accident.

### Laid out, not printed

Conversation stays as streaming text: a chat should look like a chat. A
command's answer is not conversation — it is a list, or a code — so the
structured half of what `handleCommand` returns travels as `data` and each
surface lays it out its own way. Discord gets an embed with the brand colour
and every memory linked to the blob that holds it; Telegram gets the same in
HTML, with link previews off so ten memories don't drag a preview card behind
them.

HTML rather than Markdown on Telegram, and only for these: a memory is
whatever somebody typed, and one unbalanced `*` in it makes Telegram reject
the whole message rather than render it plainly. That is how a memory list
becomes silence. In HTML three characters need escaping and they always can be.

### The bots' own profile

Telegram gets a description (the text on the empty chat, its one chance to
explain itself before being spoken to), a short description for its profile
card, and command lists scoped per chat type — a group is never offered
`/whatyouknow`, because printing someone's memories into a room full of people
is not a thing to put one tap away. Discord sets its own avatar on first
connect and a listening status.

The mark itself is `src/web/assets/avatar.png`: the site's own icon, rendered
and re-centred so it survives a circular crop down to 32px.

## How memory works

- **Writing.** Conversation turns go to the relayer's `analyze()`, which extracts
  discrete facts **server-side inside the TEE**. The raw conversation is never
  sent to the chat model just to be summarised, and fact extraction costs no
  model tokens. Turns carry an `occurredAt` anchor so "next Friday" is resolved
  to a real date before it is embedded.
- **Reading.** Recall runs across every namespace the person owns (their own,
  plus any merged in by linking), budgeted with `maxTokens` so a long memory
  never crowds the context window, and weighted slightly toward recency so a
  correction beats the thing it corrected.
- **Receipts.** A memory exists only when a confirmed `blob_id` comes back.
  Every confirmed write is appended to `blob-ledger.jsonl` and served at
  `/api/ledger`, so any blob id can be checked on Walruscan. The web chat shows
  them landing live.
- **Identity is exact, never semantic.** A surface account maps to a person via
  a namespace derived deterministically from its id. Identity is never resolved
  by vector similarity — a "close enough" match would hand one user another
  user's memories.
- **Recalled text is data, never instructions.** Memories are fenced in the
  prompt and the model is told they can be written by anyone. In a multi-user
  bot this matters: a memory one person creates can surface in another's context.
- **Supersession.** Walrus Memory is append-only, so mutable records (identity,
  opt-out) are superseded rather than edited, and the current value is selected
  on `created_at` — not on relevance rank, which happily returns stale records.
  See [docs/memwal-feedback.md](docs/memwal-feedback.md).

## Layout

| Path | What it is |
| --- | --- |
| [src/core/memory.mjs](src/core/memory.mjs) | Walrus Memory layer: receipts, recall budgets, newest-wins reads |
| [src/core/identity.mjs](src/core/identity.mjs) | People, surface accounts, link codes, opt-out |
| [src/core/agent.mjs](src/core/agent.mjs) | One chat turn: recall → fenced prompt → answer → learn |
| [src/core/commands.mjs](src/core/commands.mjs) | `/link` and friends, shared by every surface |
| [src/core/session.mjs](src/core/session.mjs) | The single entry point all surfaces call |
| [src/core/llm.mjs](src/core/llm.mjs) | OpenRouter, open-weight models only |
| [src/adapters/](src/adapters/) | Telegram (long polling) and Discord (gateway) |
| [src/web/index.html](src/web/index.html) | Landing page — centred, ceramic/suede ground, one button per surface |
| [src/web/chat.html](src/web/chat.html) | The chat panel (source) |
| [src/web/memory.html](src/web/memory.html) | The memory dashboard (source) |
| [src/web/history.html](src/web/history.html) | Past conversations (source) |
| [src/web/app.html](src/web/app.html) | **Generated.** The three above fused into one document — do not edit |
| [src/web/assets/router.js](src/web/assets/router.js) | Switches panels, keeps the URLs real, opens a panel's data once |
| [src/web/assets/shell.css](src/web/assets/shell.css) | Panel layout: one header, one panel showing |
| [src/web/assets/app.js](src/web/assets/app.js) | Shared request cache, nav counts, plain-English failures |
| [tools/build-shell.mjs](tools/build-shell.mjs) | Builds `app.html` — scopes each panel's CSS so they cannot collide |
| [tools/check-nav.mjs](tools/check-nav.mjs) | Drives the shell in a real browser: no reloads, no lost state |
| [tools/record-handoff.mjs](tools/record-handoff.mjs) | Records a real Telegram → Discord → web handoff, with the blob ids, for the landing page to replay |
| [src/web/assets/handoff.json](src/web/assets/handoff.json) | That recording. Real turns, real link codes, real Walrus writes; only the transport was scripted |
| [src/web/use-cases.html](src/web/use-cases.html) | What it does, on one screen: six glass tiles, and a stage with a dock that a tile grows into. Real screenshots, auto-advancing, nothing below the fold |
| [src/web/assets/shots/](src/web/assets/shots/) | Those screenshots. Captured with puppeteer against real accounts, not drawn |
| [tools/seed-resume.mjs](tools/seed-resume.mjs) | Gives a web user a few finished conversations, so the "pick it back up" capture has real rows |
| [src/core/time.mjs](src/core/time.mjs) | Pins relative dates to the calendar in stored text; parses them back |
| [src/core/followups.mjs](src/core/followups.mjs) | Picks a plan whose day has passed to ask about, once, and remembers having asked |
| [src/core/documents.mjs](src/core/documents.mjs) | Reads a text file into something worth remembering, and refuses what it cannot read |
| [src/core/modes.mjs](src/core/modes.mjs) | The four modes, where the chosen one is stored, and what a message suggests |
| [src/core/onboard.mjs](src/core/onboard.mjs) | The introduction: turns each answer into a memory, tracks the blob it landed in, marks it done |
| [src/web/welcome.html](src/web/welcome.html) | The introduction itself: five optional steps on glass cards, receipts landing along the bottom |
| [src/web/assets/avatar.png](src/web/assets/avatar.png) | The bots' face. Discord uploads it itself; Telegram's is set through BotFather, which has no API for it |
| [src/web/assets/og.jpg](src/web/assets/og.jpg) | The card a shared link unfurls into |
| [tools/check-telegram.mjs](tools/check-telegram.mjs) | The Telegram adapter driven by a Telegram that isn't there: `fetch` is stood in for, and what the bot tried to send is read back |
| [tools/check-files.mjs](tools/check-files.mjs) | What the chat offers to accept is what it can actually read and keep |
| [tools/check-bots.mjs](tools/check-bots.mjs) | The quick actions both bots offer, checked without a bot: every button leads to a real command, fits its platform's limits, and is drawn by the real keyboard builders |
| [tools/check-known.mjs](tools/check-known.mjs) | Runs turns with memory switched off for a known person and fails if it ever greets them as a stranger |
| [tools/build-docs.mjs](tools/build-docs.mjs) | Turns this README and the MemWal findings into `/docs`: a carousel of glass cards, one per section, each opening into a reader. Generated, so it cannot drift from the source |
| [tools/shot.mjs](tools/shot.mjs) | Screenshots the running UI, for designing against what it really looks like |
| [docs/memwal-feedback.md](docs/memwal-feedback.md) | Bugs and improvements found while building |

## The app shell

`/chat`, `/memory` and `/history` are three panels in one document, not three
pages. Switching between them shows one and hides another — the header is never
replaced, no script re-runs, and a panel you have already opened keeps its
scroll position, its data, and whatever you had typed. A lap around all three
reads nothing from Walrus; measured, a switch takes about 30ms.

The header carries two pills, Chat and Memory. Past conversations live in the
rail beside the chat, listed with which app each one happened on — seeing
"Telegram · 2h ago" in the web sidebar is the cross-surface story without a word
of explanation. The History panel is still there behind "See all", with search
across everything and the Walrus blob badges; it just no longer needs a pill.

They stay three separate source files, because they collide everywhere: `.list`
and `.sub` mean different things in each, and `--r` is 24px in chat and 20px in
the other two. `npm run build` scopes each panel's CSS under its own id and
re-points its variables, then writes `src/web/app.html`.

**Edit `chat.html`, `memory.html` or `history.html`, then run `npm run build`.**
Never edit `app.html` — it is overwritten. Each source page is still served at
its own `.html` name, so either half can be opened standalone when something
breaks and you need to know which one owns the bug.

## The memory page

`/memory` is a shelf of collections rather than one long list: Photos, Still
open, Plans, Your setup, Projects & work, Preferences, About you, and
Everything else. A memory lands on the first shelf whose keyword test matches,
in that order, so "stuck on a 403" is Still open before it is anything else
and an interview on Thursday is a plan before it is the tools it names. Keyword
tests, not a model: they run on every render, and being wrong costs a memory
sitting one shelf over.

Covers are drawn in type: an ASCII figure for each shelf over a field of
scattered characters seeded from the shelf's name, so every cover differs and
every reload draws the same one. Photos shows a collage of real pictures
instead, once there are any.

Each cover opens into its collection, where every memory still carries its
date, the app it was written on, whether it was ever read again, the id of the
blob that holds it, and "Not right". Photos are a grid with a lightbox, built
from the picture namespace (`listImages()`), with the vision model's description
and what you said when you sent it. Which collection is open lives in the URL
hash, so the back button steps out of it.

### While it thinks

The three dots are gone. A turn opens with a slate in the reply bubble: *Reading
your memory* with a clock, then *Thinking*, then *Saving to Walrus* (which
happens after the reply, through the outbox). The server sends one stage event
on the stream when recall finishes — how many things it found, how many
pictures, how long that took — and the first streamed word replaces the slate.
Past six seconds the label changes to "Memory is slow right now", because a
slow relayer read looks exactly like a hung page without a clock on it.

Above the composer sit quick controls: **New chat** (also ⌘K / Ctrl+K), *What
do you know about me?*, *Bring back a picture* (prefills the composer),
*Summarise this chat*, and *Link Telegram or Discord*. New chat was in the ⋯
menu before, and nobody found it.

## The introduction

A chatbot that remembers has nothing to show in its first conversation, so a
new person can choose to be introduced first. `/welcome` asks five things, one
to a screen, every one skippable: a name, what they want it for, how they like
answers (plus their tools, if they picked coding), a picture, and their other
apps. Someone arriving at the site for the first time is sent there by the
landing page's own button; anyone this browser has seen before goes straight
to the chat, and the introduction is one tap to leave from every screen. It is
also offered from a card on the chat's empty state, and never stands in the
way of just talking.

Every answer is an ordinary memory (`src/core/onboard.mjs`): written verbatim
to the person's own namespace through the outbox, one blob per step rather than
per chip, with its blob id shown on the page as it lands. Nothing is kept in a
side table, so a wrong answer is corrected on the memory page like any other.
The picture goes to the picture bank. A record in `ws8::onboard::<person>` marks
it done, so opening it again starts from the earlier answers and writes only
what changed.

Afterwards the chat greets them by name and offers starters that match the jobs
they chose, and the first real message is answered using the name, the tools
and the preferred length and tone.

## Modes

Four of them — Tutor, Coding partner, Planner, Support desk — and none by
default. A mode changes the manner and nothing else: the same memories, the
same namespace, the same person answering. One that also partitioned memory
would turn a single assistant that knows you into four that each know a
quarter, which is the thing this was built to avoid.

It is stored in `ws8::mode::<person>`, superseded on change and cached per
person, which makes it a memory rather than a session setting — so choosing
Tutor on Telegram is choosing it on Discord and the web. That is the
cross-app claim demonstrated in one tap rather than described.

`/mode` on either bot lists them as buttons; the web has the same thing as
chips. The introduction already asks what you want it for, and four of those
six answers *are* modes, so picking "a tutor" there sets it rather than
asking the same question twice.

### It offers, once

A message that plainly asks to be taught, or carries a stack trace, gets a
sentence at the end of the reply asking whether you want that mode — with a
button next to it. Only ever to someone who has not chosen: once you have
picked, being nudged elsewhere is second-guessing you, and this exists for
people who do not know the feature is there. At most one offer every twenty
minutes, so a decline is respected.

The overlays are about manner and grant nothing. `tools/check-bots.mjs`
asserts that, along with every mode having a button on both bots.

## Attachments

An image cannot itself be a memory: Walrus Memory stores text, and every write
method on the SDK takes a string. What can be a memory is a *description* — and
a good one outlives the file. "A 403 from publisher.walrus.space with an empty
Authorization header" is worth carrying to Telegram; the PNG is not.

So an attachment takes two paths. A small vision model reads the image and the
description goes into memory like anything else said in that conversation,
which means it crosses surfaces and shows up in recall. The bytes are kept and
served back separately.

### Where the bytes go

For a long time "separately" meant a volume on Railway, and that was the wrong
half to leave behind. The description is a memory, so it is on Walrus and
durable; the bytes were on a disk a redeploy empties. The memory outlived the
file it described, and the dashboard had to say so: *file no longer on this
server.*

The bytes now go to Walrus too, started in parallel with the vision call so the
upload costs almost no wall clock, and never awaited in a way that can fail a
turn — an upload that does not land costs durability, not the reply. The blob
id is written **into the memory**, beside the filename:

```
A file the user shared on telegram, 4 Oct 2026 (lease.pdf): A residential
tenancy agreement for 14 Oak Road…
[file:d86524ec-….md][walrus:nMxaSHx54ESfmruT6HCCOnVlGTZdmtRc3JPn-hLJ-zc]
```

That is the whole design. The pointer to a file is recovered by the same read
that finds the file, so there is no database to keep in sync and no sidecar
state to lose. The volume becomes a cache: served from disk when the bytes are
there because it is faster, from `/blob/<id>` when they are not. A file is
"available" when either can produce it, which is why the Files shelf now
distinguishes *also on Walrus* from *served from Walrus* from *bytes not
recoverable* instead of treating the last two as the same apology.

One honest split. Memories go to Walrus **mainnet**, because the relayer pays
for them. Raw blobs have no such sponsor: mainnet writes cost WAL and SUI from
a funded wallet and the public mainnet publishers are not open, so the default
publisher is **testnet** — open, free, and really erasure-coded. The network
travels with every blob id and is shown wherever the id is shown, because
saying "the files are on mainnet" while they are on testnet is exactly the kind
of small lie this project is otherwise about not telling. `WALRUS_PUBLISHER`
and `WALRUS_AGGREGATOR` are the only two things that change.

The looking is done by a cascade, not one model: `qwen/qwen3.8-flash`, then
`qwen/qwen3-vl-8b-instruct`, then `meta-llama/llama-4-scout` (override with
`VISION_MODEL`, comma-separated), in three rounds. One evening the first was
rate-limited upstream for an hour and every photo sent in that hour came back
"could not read", which meant unfindable for good. The browser also shrinks
photos over 600KB to 1600px before upload; a 2MB phone screenshot was pushing
the model past its 40-second limit for no gain in what it could see.

### Text files

A `.txt`, `.md`, `.csv` or `.json` is read rather than looked at, and the words
become the memory. A short one is kept verbatim — nothing a model could write
about a two-line note is more findable than the note. A longer one gets a
description in the same spirit as a photo's, with the exact names, errors and
numbers preserved and its opening quoted, then flows into memory by the same
path an attachment always has.

Send a deployment runbook and ask a week later where the volume is mounted;
the answer comes from the seven facts the file turned into, each its own blob.

**PDFs are no longer offered.** The accept list used to include them and
stored "a PDF file named report.pdf (240KB)" — a sentence matching nothing
anyone would ever search for, so the file was lost the moment it arrived.
Extracting text from a PDF needs a real parser, and half-accepting one is
worse than saying no; they belong to the v2 plan, where a file becomes a blob
in its own right. `tools/check-files.mjs` fails if the accept list ever offers
something `documents.mjs` cannot read.

Worth being precise about what is durable: **the description is on Walrus, the
file is on disk.** On a platform with an ephemeral filesystem the file does not
survive a redeploy and the memory of it does. Putting the bytes on Walrus too
needs either a publisher (there are no public unauthenticated publishers on
Mainnet) or `rememberManual()`, which accepts SEAL-encrypted bytes and an
embedding you generate yourself — a second implementation of the memory layer
rather than a flag to flip.

### When memory does not answer

The relayer returns nothing for a matching query about four times in ten, and
rate-limits on top. Three rules keep that from showing:

- **What it read last is still true.** The agent keeps each person's last
  non-empty recall for six hours and falls back on it when a turn's recall
  comes back empty or fails, marked to the model as not a fresh search.
- **Known is not the same as readable.** If a person's namespace has ever held
  anything, the model is told it knows them even when nothing could be read,
  and it is forbidden from calling this a first conversation or saying it has
  no memory of them. `tools/check-known.mjs` produces that failure on purpose
  and reads the replies for the sentences it must never say.
- **A write is never dropped for want of a read.** When the opt-out cannot be
  read, the write is queued with a guard and the outbox asks again before it
  sends. Pictures still in the queue are found by `findImages()` too, so "did
  you keep that photo?" a minute after sending it is answered yes, with the
  photo.

## Conversations

Transcripts live in their own namespace, apart from memories, because the two
want different handling: a memory is a fact worth keeping forever and gets
extracted, deduped and recalled semantically, while a transcript is read whole
and in order.

One blob per conversation, not per turn — writing every message would double
the cost of a turn against an hourly quota that is already tight. A conversation
saves itself once it goes quiet, and on `SIGTERM`, so a redeploy does not eat
what is in flight. The save goes through the same outbox as every other write:
for a while it was a direct call, and a conversation that closed during a
relayer rate limit was logged and lost.

## Time, and what it does with it

Relative dates are pinned to the calendar in the text that gets stored:
"interview on Thursday" is written as "interview on Thursday (1 Oct 2026)"
(`time.mjs`, deterministic, no model). The model is told today's date and what
the brackets mean, so it can tell what has happened from what is still to come.

Once a plan's day has passed, the bot asks about it — once. Each turn looks at
the dated memories already in context (plus one extra read for dated plans on
a person's first message of the day) for a plan whose date fell in the last ten
days, hands the model a single follow-up note, and records it as asked in
`followups.json` beside the outbox (`followups.mjs`). Asking about the same
interview every message would be worse than never asking.

Recall is conversation-aware: a short or anaphoric message ("and the second
option?", "yes, that one") is searched with the previous user turn in front of
it, and extraction is given the assistant's question a short answer replies to,
so "yes, part-time" becomes a fact about the person instead of nothing. Same
number of reads either way.

## What's next (v2)

The direction this is heading, after the hackathon submission: an AI workspace
rather than a chat window, where conversations, memories, files and things the
assistant makes for you all hang off the same identity.

- **Files the account owns, not just files it can read.** Half of this shipped:
  an attachment's bytes go to Walrus, and the blob id travels inside the memory
  that describes them, so a file survives the server losing it. What is left is
  ownership — the `rememberManual()` path, with SEAL encryption and embeddings
  generated client-side, would make the blob the account's rather than the
  relayer's, and would let raw blobs go to mainnet the way memories already do.
- **Things the assistant creates.** Ask for a to-do list and get a real page,
  saved under *What I Created*, openable and editable later. This needs the
  model to call tools rather than only answer, plus somewhere durable for the
  artefacts and a way to version them.
- **Spaces.** Sections a person or the assistant can create to group related
  conversations, files and artefacts.

The hard part is not the UI. It is that an artefact is mutable and Walrus is
append-only, so editing a page means superseding it — the same problem identity
records already have, at a larger size and with a version history people expect
to be able to walk back through.

## Running it

```bash
npm install
cp .env.example .env    # add OPENROUTER_API_KEY, bot tokens
npm start
```

Walrus credentials come from `~/.memwal/credentials.json` in local development,
or from `MEMWAL_PRIVATE_KEY` / `MEMWAL_ACCOUNT_ID` in a deployment.

Surfaces are optional: with no bot tokens set, only the web chat runs.
