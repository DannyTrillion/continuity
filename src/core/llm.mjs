/**
 * Model access via OpenRouter.
 *
 * Deliberately not Claude and not GPT: this bot runs on open-weight models
 * (Kimi K2.5 by default, DeepSeek v3.2 as the fallback). Everything below is plain
 * fetch against OpenRouter's OpenAI-compatible endpoint — no vendor SDK, so
 * swapping the model is one env var.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const REASONING = process.env.REASONING ?? "off";

export const DEFAULT_MODEL = process.env.MODEL ?? "moonshotai/kimi-k2.5";
export const FALLBACK_MODEL = process.env.FALLBACK_MODEL ?? "deepseek/deepseek-v3.2";

function apiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  return key;
}

async function call(model, messages, { temperature = 0.5, maxTokens = 1000, signal } = {}) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      // OpenRouter attribution headers; harmless if the app is unlisted.
      "HTTP-Referer": process.env.PUBLIC_URL ?? "https://walrus.xyz",
      "X-Title": "Walrus Memory Chatbot",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      // Kimi K2.5 is a reasoning model, and left alone it spends the budget
      // thinking: 705 of 776 completion tokens on one ordinary question, which
      // left ~70 for the answer and truncated it mid-sentence. Replies took
      // over 20s and we paid for tokens nobody ever sees. Off, a reply lands in
      // about 3s. Set REASONING=low|medium|high if a task ever needs it back.
      ...(REASONING === "off" ? { reasoning: { enabled: false } } : { reasoning: { effort: REASONING } }),
    }),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok || body.error) {
    const meta = body?.error?.metadata ?? {};
    const err = new Error(
      `OpenRouter ${res.status}: ${body?.error?.message ?? "request failed"}` +
        (meta.provider_name ? ` (${meta.provider_name})` : ""),
    );
    err.status = body?.error?.code ?? res.status;
    err.retryable = err.status === 429 || err.status >= 500;
    err.retryAfterSeconds = meta.retry_after_seconds;
    throw err;
  }

  const choice = body?.choices?.[0];
  const msg = choice?.message ?? {};

  // Reasoning models spend max_tokens on thinking and can return a null
  // content with finish_reason "length" — a successful HTTP call with no
  // answer in it. Treat that as retryable rather than as a valid empty reply.
  const text = (msg.content ?? "").trim();
  if (!text) {
    const err = new Error(
      choice?.finish_reason === "length"
        ? `${model} exhausted its token budget on reasoning before answering`
        : `${model} returned no content`,
    );
    err.retryable = true;
    throw err;
  }

  return { text, model: body.model ?? model, usage: body.usage };
}

/**
 * Streamed completion. Same request, `stream: true`, parsed as server-sent
 * events and handed to `onDelta` a fragment at a time.
 *
 * A full reply takes around ten seconds because output tokens dominate, and no
 * prompt tweak changes that. Streaming does not make it faster; it makes the
 * wait disappear, because the first words land in about a second.
 */
async function callStream(model, messages, { temperature = 0.5, maxTokens = 1000, signal, onDelta } = {}) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_URL ?? "https://walrus.xyz",
      "X-Title": "Walrus Memory Chatbot",
    },
    body: JSON.stringify({
      model, messages, temperature, max_tokens: maxTokens, stream: true,
      ...(REASONING === "off" ? { reasoning: { enabled: false } } : { reasoning: { effort: REASONING } }),
    }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    const err = new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a frame can straddle chunks.
    let cut;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (delta) { text += delta; onDelta?.(delta); }
        } catch { /* keep-alive comments and partial frames are expected */ }
      }
    }
  }

  if (!text.trim()) {
    const err = new Error(`${model} streamed no content`);
    err.retryable = true;
    throw err;
  }
  return { text: text.trim(), model };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chat completion across a cascade of models.
 *
 * Providers 429 under load — free tiers constantly, paid ones occasionally —
 * and a support bot that dies on the first rate limit is not a support bot. So
 * we retry each model once with backoff, then fall through to the next one, and
 * only give up when every model has genuinely failed.
 */
/**
 * A network-level failure throws a bare TypeError with no `status`, so the
 * error objects this module builds never touched it: a dropped connection was
 * treated as permanent and killed the whole turn. That is where the random
 * "Something broke on my side" came from — one blip, no retry.
 *
 * Anything without a status is a transport problem, and transport problems are
 * exactly what retrying is for.
 */
const canRetry = (err) => {
  if (err?.status === 401) return false; // a bad key will not fix itself
  if (err?.retryable !== undefined) return err.retryable;
  return !err?.status; // fetch failed, socket reset, DNS
};

export async function chat(messages, opts = {}) {
  const cascade = opts.model ? [opts.model] : [DEFAULT_MODEL, FALLBACK_MODEL];
  const run = opts.onDelta ? callStream : call;
  const attempts = 3;
  let last;

  for (const [i, model] of cascade.entries()) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await run(model, messages, opts);
        return { ...res, fellBack: i > 0 };
      } catch (err) {
        last = err;
        if (err?.status === 401) throw err;
        if (!canRetry(err) || attempt === attempts - 1) break;
        const wait = Math.min((err.retryAfterSeconds ?? 0) * 1000 || 600 * 2 ** attempt, 5000);
        console.warn(`[llm] ${model} failed (${err.status ?? "network"}), retry ${attempt + 1}/${attempts - 1} in ${wait}ms`);
        await sleep(wait * (0.7 + Math.random() * 0.6));
      }
    }
  }

  throw last ?? new Error("no model available");
}
