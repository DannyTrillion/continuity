---
name: technical-article
description: Write or audit a technical article about something you built — hackathon write-ups, launch posts, engineering blog pieces. Use when the piece has to convince a reader who can check your claims. Covers the evidence standard, structure, what to cut, and the self-audit before publishing.
---

# Writing about something you built

Most write-ups about a project fail the same way: they describe. The reader
finishes knowing what you claim and has no way to tell whether any of it is
true. A judge reading forty submissions can't check forty claims, so they stop
checking and start scanning for the one that doesn't need checking.

Be that one.

## The rule everything else follows from

**Every claim either carries its evidence or gets cut.**

Not "we built a fast memory layer." A number, measured, with the command that
produced it. Not "data is encrypted." Two blob ids and a `curl` that returns
ciphertext from one and plaintext from the other. If a claim can't be checked
by a stranger, either find the evidence or delete the sentence.

This is harder than it sounds, because it kills your favourite lines. Run the
measurement before you write the number. A figure typed from memory is wrong
within a week, and the one thing worse than thin evidence is evidence that
contradicts your own live site when somebody looks.

**Derive numbers, don't type them.** Write a script that measures against the
live deployment and refuses to print a row it couldn't verify. Then the article
is regenerated, not maintained. (See `tools/proof.mjs` in this repo.)

## Lead with the argument, not the chronology

Nobody cares what you did on day one. They care why this exists and why the
obvious cheaper version is wrong.

Open with the position somebody would argue with. "A support bot is a setting,
not a product" is an opening. "In this article I'll walk through how I built
Continuity" is a table of contents.

Then earn it. The reader who disagreed with your first paragraph is the one
worth writing for.

## Admit the thing that makes you look bad

The single most persuasive move available: find the worst thing you did and
put it in, plainly, with what it cost.

Not a humble-brag failure ("I was too ambitious"). A real one. A mistake that a
reader could reasonably judge you for. Writing it down is the only credential
that can't be faked, and it buys belief in everything else on the page.

Two rules. State it without flinching or over-apologising; one sentence of
contrition, then the facts. And say what you did about it, or that you couldn't.

## What goes in, what stays out

In:
- A thing a reader can run, early
- Exact failure modes, with the symptom and the cause
- Numbers you measured, with the spread, not just the flattering one
- What you did not build, named, before anyone asks
- Real names: the library, the version, the error string

Out:
- Architecture diagrams nobody asked for
- Your tech stack as a list
- Anything phrased as a benefit rather than a behaviour
- Round numbers that smell estimated
- Comparisons to competitors you haven't run

## Length

Cut until it hurts, then check the evidence is still intact. Prose is what you
trim; receipts are what you keep. A reader skimming for proof should find it
without reading the prose at all, and a reader reading every word should never
hit a paragraph that only restates the one above.

Two destinations usually want two lengths. Write the long one, then cut a
short one that leads with the product and drops the war stories. Generate both
from one source so they can't drift.

## Before publishing — the audit

Run `node tools/check-prose.mjs <file.md>`. It counts the tells: banned
vocabulary, em dashes against budget, three consecutive sentences of the same
length. Then:

1. **Every link, resolved.** Not "looks right" — fetched, with the status code.
   A dead link in a piece about verifiability is the worst possible dead link.
2. **Every number, re-measured** against production on the day.
3. **Every image reference, confirmed to exist** in the folder you're pasting from.
4. **Read the evidence blocks as a stranger.** Can they copy the command? Does
   it work with no setup? Is the output what you said it would be?
5. **Find the claim you'd least like challenged.** Either strengthen its
   evidence or weaken the claim.

## Voice

Follow the `anti-ai-slop-writing` skill for vocabulary and rhythm. Beyond it:

Short sentences carry weight; long ones carry detail. Alternate deliberately.
Use the specific word even when it's uglier. Contractions throughout. Let a
paragraph stop without a transition when the thought is done.

Never let a sentence apologise for the one after it. "It's worth noting that
we also added X" is three words of throat-clearing in front of "we added X."

The tone to aim for is somebody explaining a hard problem to a peer who will
notice if you're overselling. Not a pitch. Not a tutorial. A report from
somebody who was there, written for somebody who might do it next.
