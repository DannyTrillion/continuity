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
| `/link` | Issue a 6-character code (valid 10 minutes) |
| `/link CODE` | Redeem a code from another surface |
| `/whatyouknow` | List what it remembers about you |
| `/forgetme confirm` | Stop recording and stop reading you back |
| `/remember me` | Undo the above |

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
| [src/web/chat.html](src/web/chat.html) | The chat itself, served at `/chat` |
| [src/web/assets/](src/web/assets/) | Background texture (generated) |
| [tools/shot.mjs](tools/shot.mjs) | Screenshots the running UI, for designing against what it really looks like |
| [docs/memwal-feedback.md](docs/memwal-feedback.md) | Bugs and improvements found while building |

## Attachments

An image cannot itself be a memory: Walrus Memory stores text, and every write
method on the SDK takes a string. What can be a memory is a *description* — and
a good one outlives the file. "A 403 from publisher.walrus.space with an empty
Authorization header" is worth carrying to Telegram; the PNG is not.

So an attachment takes two paths. A small vision model reads the image and the
description goes into memory like anything else said in that conversation,
which means it crosses surfaces and shows up in recall. The bytes are kept and
served back separately.

Worth being precise about what is durable: **the description is on Walrus, the
file is on disk.** On a platform with an ephemeral filesystem the file does not
survive a redeploy and the memory of it does. Putting the bytes on Walrus too
needs either a publisher (there are no public unauthenticated publishers on
Mainnet) or `rememberManual()`, which accepts SEAL-encrypted bytes and an
embedding you generate yourself — a second implementation of the memory layer
rather than a flag to flip.

## Conversations

Transcripts live in their own namespace, apart from memories, because the two
want different handling: a memory is a fact worth keeping forever and gets
extracted, deduped and recalled semantically, while a transcript is read whole
and in order.

One blob per conversation, not per turn — writing every message would double
the cost of a turn against an hourly quota that is already tight. A conversation
saves itself once it goes quiet, and on `SIGTERM`, so a redeploy does not eat
what is in flight.

## What's next (v2)

The direction this is heading, after the hackathon submission: an AI workspace
rather than a chat window, where conversations, memories, files and things the
assistant makes for you all hang off the same identity.

- **Files as first-class memories.** The `rememberManual()` path — SEAL
  encryption and embeddings generated client-side — so a PDF or an image is
  itself a blob the account owns, not just a description of one.
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
