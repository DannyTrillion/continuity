/**
 * Looking at what someone attached.
 *
 * Walrus Memory only stores text, so an image cannot itself become a memory.
 * What can is a description of it — and a good description is genuinely useful:
 * "a 403 from publisher.walrus.space with an empty Authorization header" is a
 * fact worth carrying to Telegram, while the PNG is not.
 *
 * A small vision model does the looking. It is a different model from the one
 * that holds the conversation, chosen for being cheap and quick rather than
 * clever, because all it has to do is say what is on the screen.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// qwen3.8-flash rather than a cheaper flash model: GLM's endpoint makes
// reasoning mandatory, so it spends the whole token budget thinking and
// returns an empty answer — the same trap Kimi fell into on the chat path.
//
// Then two more, because one provider having a bad hour was enough to make
// every photo sent that hour unfindable forever. All open-weight, so the
// "no Claude, no GPT" line stays true whichever one answers.
const VISION_MODELS = (process.env.VISION_MODEL ?? "qwen/qwen3.8-flash,qwen/qwen3-vl-8b-instruct,meta-llama/llama-4-scout")
  .split(",").map((m) => m.trim()).filter(Boolean);

export const canSee = (type) => /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(String(type));

/**
 * Describe an image in a way that is useful months later, with no surrounding
 * conversation to explain it.
 */
export async function describeImage(dataUrl, { hint } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, error: "No model key configured." };

  let last;
  for (const model of VISION_MODELS) {
    const seen = await lookWith(model, key, dataUrl, hint);
    if (seen.ok) return seen;
    last = seen;
    console.error(`[vision] ${model}: ${seen.error}`);
  }
  return last;
}

async function lookWith(model, key, dataUrl, hint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.PUBLIC_URL ?? "https://walrus.xyz",
        "X-Title": "Walrus Memory Chatbot",
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0.2,
        reasoning: { enabled: false },
        messages: [
          {
            role: "system",
            content:
              "Describe what is in this image so someone reading only your words months " +
              "later would know what it showed.\n\n" +
              "- Read out any error messages, URLs, commands, numbers or labels EXACTLY.\n" +
              "- Say what kind of thing it is: a terminal, a browser, a diagram, a photo.\n" +
              "- Be concrete and brief. Four sentences at most.\n" +
              "- Describe only what is visible. Never guess at what it means or what caused it.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: hint ? `The person said: ${hint}` : "What is this?" },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      // OpenRouter's own message is "Provider returned error", which says
      // nothing; the provider's reason sits underneath it.
      const raw = body?.error?.metadata?.raw;
      const why = body?.error?.message ?? `vision model returned ${res.status}`;
      return { ok: false, error: raw ? `${why}: ${String(raw).slice(0, 160)}` : why };
    }
    const text = body?.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false, error: "The vision model returned nothing." };
    return { ok: true, description: text, model: body.model ?? model };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "Looking at that took too long." : "Couldn't look at that image." };
  } finally {
    clearTimeout(timer);
  }
}
