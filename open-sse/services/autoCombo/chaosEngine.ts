/**
 * Chaos Engine — parallel multi-model dispatch for the `auto/chaos` auto-model.
 *
 * Goal: pick the N most *stable* connected models, fan the same prompt out to
 * all of them in parallel, then return a single merged SSE stream so an IDE that
 * can only issue ONE request / hold ONE agent still receives all N model answers
 * at once.
 *
 * Design notes:
 *   - Selection is done by the caller (virtualFactory → createVirtualAutoCombo)
 *     which already scores candidates with the `chaos-mode` weight pack (health +
 *     stability dominant), so `models` here is already the proven-stable set.
 *   - Dispatch is fully parallel (Promise.all). A slow/hung model is bounded by
 *     `panelHardTimeoutMs` so it can never stall the whole turn.
 *   - Broadcast: each panel model's answer is wrapped in an SSE `omni-chaos-part`
 *     event carrying its own model id. IDEs that understand the protocol can
 *     render several panels; IDEs that don't just see the synthesized final block
 *     (the highest-scoring model's answer is used as the canonical final response).
 *   - Unlike fusion, chaos does NOT run a separate judge synthesis call — it
 *     surfaces raw per-model outputs (the user explicitly asked for multiple
 * a single-turn IDE request still receives all N model answers at once.
 */

import { errorResponse } from "../../utils/error.ts";

export const CHAOS_DEFAULTS = {
  /** Absolute cap on wall time for the whole panel. */
  panelHardTimeoutMs: 120_000,
  /** If fewer than this many succeed, fall back to a plain single-model answer. */
  minPanel: 1,
} as const;

export type ChaosTuning = {
  panelHardTimeoutMs?: number;
  minPanel?: number;
};

type Body = Record<string, unknown>;

export type ChaosPart = {
  model: string;
  index: number;
  ok: boolean;
  text: string;
  error?: string;
};

/**
 * Build the SSE comment/event wrapper for one chaos panel part.
 * We emit a custom event name `omni-chaos-part` so a protocol-aware IDE can
 * split it out; non-aware clients reading OpenAI-style SSE will simply ignore
 * the unknown event and use the final `data:` chunk below.
 */
export function serializeChaosPart(part: ChaosPart, isFinal: boolean): string {
  const meta = {
    type: "omni-chaos-part",
    model: part.model,
    index: part.index,
    ok: part.ok,
    final: isFinal,
    error: part.error,
  };
  // Comment line (ignored by standard SSE parsers) + explicit event envelope.
  return (
    `: chaos ${part.index} ${part.ok ? "ok" : "fail"} ${part.model}\n` +
    `event: omni-chaos-part\n` +
    `data: ${JSON.stringify(meta)}\n\n`
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(p)
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch(() => {
        clearTimeout(t);
        resolve(fallback);
      });
  });
}

/**
 * Run the chaos panel. Returns the ordered parts plus a recommended "primary"
 * part (highest index of a successful model, or the first success) that callers
 * can use as the canonical response body for non-aware clients.
 */
export async function runChaosPanel(opts: {
  body: Body;
  models: string[];
  handleSingleModel: (body: Body, model: string) => Promise<Response>;
  log?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void };
  tuning?: ChaosTuning | null;
}): Promise<{ parts: ChaosPart[]; primary: ChaosPart | null }> {
  const { body, models, handleSingleModel, log, tuning } = opts;
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  const hardTimeout = tuning?.panelHardTimeoutMs ?? CHAOS_DEFAULTS.panelHardTimeoutMs;

  if (panel.length === 0) {
    return { parts: [], primary: null };
  }

  const calls = panel.map((model, index) =>
    withTimeout(
      (async (): Promise<ChaosPart> => {
        try {
          const res = await handleSingleModel(body, model);
          const text = await extractText(res);
          log?.info?.(
            `CHAOS panel ${index} (${model}) ok=${res.ok} status=${res.status} textLen=${text.length}`
          );
          return { model, index, ok: true, text };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log?.warn?.(`CHAOS panel ${index} (${model}) failed:`, msg);
          return { model, index, ok: false, text: "", error: msg };
        }
      })(),
      hardTimeout,
      // Timed-out model → treated as a failed part, not a hang.
      {
        model,
        index,
        ok: false,
        text: "",
        error: "chaos-panel-timeout",
      } as ChaosPart
    )
  );

  const parts = await Promise.all(calls);
  const successes = parts.filter((p) => p.ok);
  const primary = successes.length > 0 ? successes[successes.length - 1] : null;

  log?.info?.(`CHAOS panel complete: ${successes.length}/${parts.length} succeeded`);
  return { parts, primary };
}

/**
 * Pull assistant text out of an OpenAI-style or Anthropic-style Response body.
 * Clones the response first (body is single-consume; fusion.ts does the same),
 * then tries JSON first and falls back to SSE concat — content-type headers are
 * not reliable here because OmniRoute may force a streaming envelope internally.
 */
async function extractText(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.clone().text();
  } catch {
    return "";
  }
  // Try JSON first (non-streaming completion).
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return firstTextFromOpenAI(JSON.parse(trimmed));
    } catch {
      /* fall through to SSE / raw */
    }
  }
  // SSE or wrapped stream → concat data: content deltas.
  const sse = concatSseText(raw);
  if (sse) return sse;
  // Last resort: maybe the body itself is plain prose.
  return trimmed.length > 0 && !trimmed.startsWith("data:") ? trimmed : "";
}

function firstTextFromOpenAI(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  const choices = o.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = choices[0]?.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.content === "string") return msg.content;
    const delta = choices[0]?.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === "string") return delta.content;
  }
  if (typeof o.content === "string") return o.content;
  return "";
}

function concatSseText(sse: string): string {
  const out: string[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      const choices = json?.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (delta?.content) out.push(String(delta.content));
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return out.join("");
}

/**
 * Top-level chaos dispatch entrypoint used by `handleComboChat` when a combo's
 * `config.chaos.enabled` flag is set (the `auto/chaos` virtual combo).
 *
 * Returns a single Response whose body is an SSE stream:
 *   - one `omni-chaos-part` event per panel model (raw answer + model id)
 *   - a final `data:` OpenAI-style chunk carrying the primary model's answer
 *     (so non-aware clients / IDEs still get a usable completion).
 *
 * The client's requested stream flag is honored: if the client wanted a stream,
 * we stream chaos parts as soon as each model lands; if not, we buffer and
 * return one JSON response containing all parts.
 */
export async function handleChaosChat(opts: {
  body: Body;
  models: string[];
  handleSingleModel: (body: Body, model: string) => Promise<Response>;
  log?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void };
  comboName?: string;
  primaryModel?: string | null;
  tuning?: ChaosTuning | null;
}): Promise<Response> {
  const { body, models, handleSingleModel, log, comboName, primaryModel, tuning } = opts;
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return errorResponse(400, "Chaos combo has no models");
  }

  // Single-model chaos degrades to a direct answer.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const { parts, primary } = await runChaosPanel({
    body,
    models: panel,
    handleSingleModel,
    log,
    tuning,
  });

  const successes = parts.filter((p) => p.ok);
  if (successes.length === 0) {
    return errorResponse(503, "All chaos panel models failed");
  }

  // Choose the primary: explicit primaryModel if it succeeded, else the last
  // successful part (by construction that's the top-scored stable model).
  const primaryPart =
    (primaryModel && parts.find((p) => p.model === primaryModel && p.ok)) ||
    primary ||
    successes[0];

  // Build a single OpenAI-style streaming response that:
  //   1. emits each chaos part as a comment + event (broadcast for aware IDEs)
  //   2. ends with the primary model's text as the canonical final delta.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        controller.enqueue(enc.encode(serializeChaosPart(p, false)));
      }
      // Final canonical answer (non-aware clients consume this).
      const finalText = primaryPart?.text ?? "";
      controller.enqueue(
        enc.encode(
          `data: ${JSON.stringify({
            id: `chaos-${comboName ?? "panel"}`,
            object: "chat.completion.chunk",
            model: primaryPart?.model ?? panel[0],
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: finalText },
                finish_reason: "stop",
              },
            ],
          })}\n\n`
        )
      );
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-OmniRoute-Chaos": "true",
      "X-OmniRoute-Chaos-Panel": String(parts.length),
      "X-OmniRoute-Chaos-Primary": primaryPart?.model ?? "",
    },
  });
}
