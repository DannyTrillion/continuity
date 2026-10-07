# press

Everything needed to publish, in one folder. Nothing here is imported by the
app; it exists so publishing day is copying rather than hunting.

## The two articles

Two destinations, two lengths, one source. Both are generated from the styled
pages by `node tools/to-markdown.mjs <page.html> <out.md>` — edit the page and
regenerate rather than editing the Markdown, or the two drift and the one
nobody is reading goes out of date in public.

| file | where | length |
|---|---|---|
| `inkray-not-a-support-bot.md` | Inkray, first | ~1,740 words, 5 min |
| `medium-quietly-replaced.md` | Medium, canonical → the Inkray URL | ~3,540 words, 11 min |

Inkray goes first so Medium can point its canonical at it.

## Order of operations

1. Paste the Inkray Markdown into Inkray's editor.
2. Upload `continuity-cover.jpg` as the cover image.
3. Find the line `**[UPLOAD THE VIDEO HERE — …]**`, upload
   `../clips/out/continuity-demo-1080p.mp4` there, delete the marker.
   It is deliberately loud: the video cannot travel in Markdown, and a quiet
   omission is how a piece ends up referencing a film that is not there.
4. Upload `cross-app.jpg` where it is referenced.
5. Publish. Copy the URL.
6. Repeat for Medium with `medium-quietly-replaced.md`, which also wants
   `dashboard.jpg`, and set the canonical to the Inkray URL.

## The images

| file | what it is |
|---|---|
| `continuity-cover.jpg` | the cover, 2400×1350. `.png` is the lossless original |
| `cross-app.jpg` | the three surfaces reporting themselves connected |
| `dashboard.jpg` | the memory dashboard, each fact with its blob id (Medium only) |

## The cover

`continuity-cover.jpg` is rendered, not drawn and not generated:

```
node press/cover-shot.mjs      # reads cover-card.html, writes the PNG
```

Change the words in `cover-card.html` and re-render. It is built rather than
prompted because an image model mangles letterforms, and the cover is mostly
letterforms. It carries the same line as the demo video so the two match.

## What is NOT here

The video itself, because `clips/` is gitignored — 194 MB of raw footage once
went into this repository by accident and the history had to be rewritten to
get it out. The finished cut lives at `clips/out/continuity-demo-1080p.mp4`
locally.

## Before publishing

- Say `/remember me` to the bot. Opting out is still in effect on that account,
  and a live demo that is not recording is a bad look.
- `node tools/proof.mjs` re-measures every claim in the Medium before/after
  against production and refuses to print a row it could not verify. The write
  counts in both articles drift upward as the bot is used; they are honest at
  the moment of publishing and only ever understate afterwards.
