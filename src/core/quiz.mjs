/**
 * Being asked about what you uploaded.
 *
 * Questions are written from the material's own words, read off the volume
 * rather than out of memory — you cannot set a fair question from a summary of
 * the thing you are asking about.
 *
 * Multiple choice, because this is mostly read on a phone: four buttons is one
 * tap, and a typed answer on a phone is a reason not to bother. It also makes
 * a wrong answer unambiguous, which matters more than it sounds — "what they
 * got stuck on" is only worth remembering if it is reliably true.
 *
 * A quiz in progress is held in memory, not on Walrus. It is scaffolding that
 * lasts ninety seconds; what deserves to be permanent is what they got wrong,
 * and that goes through the outbox like everything else.
 */

import { chat } from "./llm.mjs";
import { materialText, rememberMistake } from "./study.mjs";

/* One quiz per person at a time. Someone who starts a second one has abandoned
   the first, which is the behaviour anyone would expect. */
const running = new Map(); // personId -> { questions, at, i, right, material }

/* Long enough to finish a round, short enough that a quiz abandoned on Monday
   is not still waiting on Thursday. */
const STALE_MS = 60 * 60 * 1000;

export const LETTERS = ["A", "B", "C", "D"];

const live = (q) => q && Date.now() - q.at < STALE_MS;

/** Is there a quiz waiting for an answer? */
export function inProgress(personId) {
  const q = running.get(personId);
  if (!live(q)) { running.delete(personId); return false; }
  return q.i < q.questions.length;
}

export const abandon = (personId) => running.delete(personId);

/**
 * Pull questions out of a model and refuse anything malformed.
 *
 * A model asked for JSON mostly returns JSON, and the times it does not are
 * exactly the times a half-parsed question would reach someone mid-quiz. So
 * every field is checked, and a question that fails any check is dropped
 * rather than patched — three good questions beat four with a broken one.
 */
function parseQuestions(raw) {
  let data;
  try {
    const text = String(raw ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    data = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  return data
    .map((q) => ({
      question: String(q?.question ?? "").trim(),
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => String(o ?? "").trim()).filter(Boolean),
      correct: Number.isInteger(q?.correct) ? q.correct : -1,
      why: String(q?.why ?? "").trim(),
    }))
    .filter(
      (q) =>
        q.question.length > 8 &&
        q.options.length === 4 &&
        new Set(q.options).size === 4 &&
        q.correct >= 0 &&
        q.correct < 4,
    );
}

/**
 * Start a round on one material.
 *
 * Returns `{ ok: false, error }` rather than throwing, because every caller is
 * a chat surface that has to say something useful to a person either way.
 */
export async function startQuiz(personId, { file, name, count = 4 }) {
  let text;
  try {
    text = await materialText(file);
  } catch (err) {
    return { ok: false, error: `I couldn't read that one back (${err.message}).` };
  }
  if (text.replace(/\s+/g, "").length < 200) {
    return { ok: false, error: "There isn't enough in that one to make questions from." };
  }

  let answer;
  try {
    answer = await chat(
      [
        {
          role: "system",
          content:
            "You write short multiple-choice questions that check whether someone has understood a " +
            "document they are studying.\n\n" +
            "Rules:\n" +
            "- Ask ONLY about what the document actually says. Never use outside knowledge.\n" +
            "- Exactly four options, one unambiguously correct, three wrong but plausible to someone " +
            "who half-read it. Never use 'all of the above' or 'none of the above'.\n" +
            "- Questions test understanding, not whether they memorised a number.\n" +
            "- `why` is one sentence saying why the answer is right, in the document's own terms.\n\n" +
            'Reply with JSON only: [{"question":"…","options":["…","…","…","…"],"correct":0,"why":"…"}]',
        },
        {
          role: "user",
          content: `Write ${count} questions on this document.\n\n"""\n${text}\n"""`,
        },
      ],
      { maxTokens: 900, temperature: 0.3 },
    );
  } catch (err) {
    return { ok: false, error: `I couldn't put questions together just then (${err.message}).` };
  }

  const questions = parseQuestions(answer?.text).slice(0, count);
  if (!questions.length) return { ok: false, error: "I couldn't make sensible questions out of that one." };

  running.set(personId, { questions, i: 0, right: 0, material: name ?? file, at: Date.now() });
  return { ok: true, total: questions.length, ...current(personId) };
}

/** The question waiting to be answered, or null. */
export function current(personId) {
  const q = running.get(personId);
  if (!live(q) || q.i >= q.questions.length) return null;
  const item = q.questions[q.i];
  return {
    index: q.i,
    number: q.i + 1,
    total: q.questions.length,
    question: item.question,
    options: item.options,
    material: q.material,
  };
}

/**
 * Answer the question in front of them.
 *
 * A miss is written to memory before the next question is handed back, so the
 * record survives them closing the app mid-round.
 */
export function answerQuiz(personId, choice) {
  const q = running.get(personId);
  if (!live(q) || q.i >= q.questions.length) return { ok: false, error: "That quiz has finished." };

  const item = q.questions[q.i];
  const picked = Number(choice);
  if (!Number.isInteger(picked) || picked < 0 || picked >= item.options.length) {
    return { ok: false, error: "That isn't one of the options." };
  }

  const right = picked === item.correct;
  if (right) q.right += 1;
  else {
    rememberMistake(personId, {
      question: item.question,
      chose: item.options[picked],
      correct: item.options[item.correct],
      material: q.material,
    });
  }

  q.i += 1;
  const done = q.i >= q.questions.length;
  const result = {
    ok: true,
    right,
    correct: item.options[item.correct],
    why: item.why,
    done,
    score: q.right,
    total: q.questions.length,
    material: q.material,
    next: done ? null : current(personId),
  };
  if (done) running.delete(personId);
  return result;
}

/** For tests, and for a clean slate. */
export const forgetQuizzes = () => running.clear();
