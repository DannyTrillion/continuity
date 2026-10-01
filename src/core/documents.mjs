/**
 * Reading a file someone sent.
 *
 * The web chat has accepted `.txt`, `.md` and `.pdf` for a while, and what it
 * stored for any of them was "a PDF file named report.pdf (240KB)" — a
 * sentence that matches nothing anyone would ever search for, so the file was
 * lost the moment it was uploaded. The UI promised something it did not keep.
 *
 * Text files are cheap to keep honestly: the words are right there. So a
 * short one becomes its own memory verbatim, and a long one gets a
 * description written the same way a photo does, by a model that was shown
 * it. Either way the result is a sentence recall can find.
 *
 * PDFs are a different problem — extracting text from one needs a real parser
 * and their content is often not text at all — so they are no longer offered
 * rather than accepted and quietly dropped. They are named in the v2 plan,
 * where files become blobs in their own right.
 */

import { chat } from "./llm.mjs";

/* What we can read as words. A `.json` or `.csv` is text too, and someone
   pasting one in has said something about themselves worth keeping. */
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|toml)$)/i;
const TEXT_EXTS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log", "yml", "yaml", "toml", "ini"]);

export const isPdf = (type, ext) =>
  /^application\/pdf$/i.test(String(type ?? "")) || String(ext ?? "").toLowerCase() === "pdf";

export const canRead = (type, ext) =>
  TEXT_TYPES.test(String(type ?? "")) || TEXT_EXTS.has(String(ext ?? "").toLowerCase()) || isPdf(type, ext);

/**
 * The words out of a PDF.
 *
 * This was refused for a long time, on the grounds that extracting text from
 * one needs a real parser and plenty of PDFs have no text in them at all. The
 * first half stopped being true — `unpdf` is a parser and it is two megabytes
 * — and the second half is still true, which is why a PDF that yields nothing
 * is reported as a scan rather than stored as an empty memory.
 *
 * Lecture notes, handouts and slide decks are overwhelmingly PDFs, so a study
 * assistant that cannot read one is a study assistant nobody uses.
 */
async function pdfText(bytes) {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text: String(text ?? "").trim(), pages: totalPages ?? 0 };
}

/** Short enough that the file is its own best description. */
const VERBATIM_LIMIT = 500;
/** What the model is shown. Beyond this a description is about the shape anyway. */
const READ_LIMIT = 12_000;

/**
 * Is this actually text, or is it something binary wearing a .txt?
 *
 * A NUL byte settles it, and so does a high proportion of control characters
 * — a mislabelled image decoded as UTF-8 is mostly replacement characters,
 * and storing that as a memory would be worse than storing nothing.
 */
function looksLikeText(s) {
  if (!s || s.includes("\u0000")) return false;
  const sample = s.slice(0, 4000);
  let odd = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) odd++;
  }
  return odd / Math.max(sample.length, 1) < 0.05;
}

const squeeze = (s) => s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/**
 * Turn a text file into something worth remembering.
 *
 * Returns the same shape as describeImage: `{ ok, description }`, so
 * storeAttachment treats a document and a photo the same way afterwards.
 */
export async function readDocument({ bytes, name, type, hint }) {
  const ext = String(name ?? "").split(".").pop()?.toLowerCase() ?? "";
  let raw;
  let pages = 0;

  if (isPdf(type, ext)) {
    try {
      ({ text: raw, pages } = await pdfText(bytes));
    } catch (err) {
      return { ok: false, error: `I couldn't open that PDF (${err.message}).` };
    }
    // A PDF of photographed pages parses perfectly and yields nothing. Saying
    // so is the honest answer; storing an empty memory and calling it read is
    // how a study assistant quietly loses someone's notes.
    if (raw.replace(/\s+/g, "").length < 20) {
      return {
        ok: false,
        error:
          pages > 0
            ? `that PDF is ${pages} page${pages === 1 ? "" : "s"} of images rather than text, so there is nothing for me to read. A scan or photos of pages won't work — I need one with selectable text.`
            : "that PDF has no text I can read.",
      };
    }
  } else {
    try {
      raw = bytes.toString("utf8");
    } catch {
      return { ok: false, error: "I couldn't read that as text." };
    }
    if (!looksLikeText(raw)) return { ok: false, error: "That doesn't look like a text file." };
  }

  const text = squeeze(raw);
  if (!text) return { ok: false, error: "That file is empty." };

  const called = name ? ` named "${name}"` : "";

  // A note, a snippet, a short list: the words are the memory. Nothing a
  // model could write about it would be more findable than the thing itself.
  const kind = pages ? `a ${pages}-page PDF` : "a text file";
  if (text.length <= VERBATIM_LIMIT) {
    return { ok: true, description: `${kind}${called} that reads:\n\n${text}`, verbatim: true, text, pages };
  }

  const lines = text.split("\n").length;
  try {
    const answer = await chat([
      {
        role: "system",
        content:
          "You are describing a document so that someone reading only your words months later " +
          "would know what it contained and could find it again by searching for it.\n\n" +
          "- Say what kind of document it is: notes, a config file, a transcript, a draft, a log.\n" +
          "- Read out any names, errors, URLs, commands, versions or numbers EXACTLY.\n" +
          "- Name what it is about in the words the document itself uses.\n" +
          "- Be concrete and brief. Six sentences at most.\n" +
          "- Describe only what is there. Never guess at why it was written.",
      },
      {
        role: "user",
        content:
          `${hint ? `The person said: ${hint}\n\n` : ""}` +
          `${kind}${called}, ${pages ? `${pages} pages` : `${lines} lines`}, ${Math.round(text.length / 1024)}KB. Contents follow.\n\n` +
          text.slice(0, READ_LIMIT) +
          (text.length > READ_LIMIT ? "\n\n[…truncated]" : ""),
      },
    ], { maxTokens: 320, temperature: 0.2 });

    const said = answer?.text?.trim();
    if (!said) return { ok: false, error: "I couldn't make anything of it." };

    // The opening of the file goes in too: a description is what makes it
    // findable, and a quotation is what makes the memory worth having.
    const opening = text.slice(0, 220).replace(/\s+/g, " ").trim();
    return {
      ok: true,
      description: `${kind}${called} (${pages ? `${pages} pages` : `${lines} lines`}): ${said}\n\nIt begins: "${opening}…"`,
      // The whole thing, for callers that need the words rather than a
      // description of them — quizzing someone on a document means reading
      // the document, and the file is already on disk beside this.
      text,
      pages,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
