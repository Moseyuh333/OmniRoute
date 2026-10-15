/**
 * OpenCode Free (`opencode`) and OpenCode Zen (`opencode-zen`) used STANDALONE (#16571, #16328).
 *
 * Both providers are served by `https://opencode.ai/zen/v1`, and on that surface the upstream
 * refuses any free-tier request that does not match the OpenCode client's own contract with
 * `403 FreeTierError` ("OpenCode's free tier can only be used from within OpenCode"). Two of
 * the four legs of that contract are still missing in a standalone install:
 *
 *   1. **The tools list is a fingerprint, not just a non-empty array.** Measured live on
 *      2026-10-02/03 against `/chat/completions` and `/responses` (9 gated free models, 121
 *      records, independently reproduced in #15322): an empty list, a lone `_noop`
 *      placeholder, a single client tool, or the capitalised `Bash` spelling are all answered
 *      403; the lowercase quartet `bash`, `glob`, `grep`, `read` is answered 200 (the minimal
 *      measured pair `bash` + `read` also passes — the quartet is kept as a safety margin).
 *      Order is irrelevant and extra tools alongside the quartet are accepted, so a caller's
 *      own tool list is kept as-is instead of being renamed.
 *
 *   2. **The session id's value is validated, not only its shape.** The 12 hex digits decode
 *      through the client's `Identifier.descending()` layout, where the low 12 bits carry
 *      `0xFFF - counter` (counter is the within-millisecond sequence, 0-63): only a low-12
 *      landing in `0xFC0-0xFFF` passes (measured 2026-10-13/14, #16328). A shape-valid id with
 *      a foreign encoding - a raw hash, an ascending id, a counter out of the window - is
 *      answered 403 even though `OPENCODE_SESSION_PATTERN` accepts it.
 *
 * The other two legs (`stream: true`, `User-Agent: opencode/<>= 1.17>`) are covered by
 * `opencode-free-tier-request-contract.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_FREE_TIER_FINGERPRINT_TOOLS,
  applyFreeTierRequestContract,
  mergeClientToolsWithObserved,
  prepareFreeTierRequest,
} from "../../open-sse/executors/opencodeFreeTierContract.ts";
import {
  OPENCODE_SESSION_PATTERN,
  OPENCODE_SESSION_VALUE_PATTERN,
  forwardOpencodeClientHeaders,
  isCanonicalOpencodeSessionValue,
} from "../../open-sse/utils/opencodeHeaders.ts";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";

/** The lowercase quartet the upstream fingerprints (measured 2026-10-02/03, #15322). */
const QUARTET = ["bash", "glob", "grep", "read"];

/** A session whose 12-hex time part keeps the counter window `0xFC0-0xFFF` (counter 0-63). */
const CANONICAL_SESSION_VALUE_RE = /^ses_[0-9a-f]{9}f[c-f][0-9a-f][0-9A-Za-z]{14}$/;

/** Same shape, foreign encoding: the low 12 bits read `9ab`, outside the accepted window. */
const FOREIGN_SESSION = "ses_0123456789ababcdefghijklmn";

const CHAT_BODY = () => ({
  model: "nemotron-3.5-lightning-free",
  messages: [{ role: "user", content: "hi" }],
});
const RESPONSES_BODY = () => ({
  model: "muse-spark-1.3-contributor-free",
  input: [{ role: "user", content: "hi" }],
});

function chatToolNames(body: unknown): string[] {
  const tools = (body as { tools?: Array<{ function?: { name?: string }; name?: string }> }).tools;
  return (tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? "");
}

test("the constants above are the ones the fix ships (no drift between test and source)", () => {
  assert.deepEqual([...OPENCODE_FREE_TIER_FINGERPRINT_TOOLS], QUARTET);
  assert.equal(OPENCODE_SESSION_VALUE_PATTERN.source, CANONICAL_SESSION_VALUE_RE.source);
  const decodable = "ses_abcdef012fcdZYXWVUTSRQPONM";
  assert.equal(isCanonicalOpencodeSessionValue(decodable), true);
  assert.equal(isCanonicalOpencodeSessionValue(FOREIGN_SESSION), false);
  assert.equal(isCanonicalOpencodeSessionValue("ses_0123456789ab"), false);
  assert.equal(isCanonicalOpencodeSessionValue(undefined), false);
});

test("a tool-less standalone request is brought up to the canonical lowercase quartet", () => {
  const body = applyFreeTierRequestContract(CHAT_BODY(), "openai") as Record<string, unknown>;
  const names = chatToolNames(body);
  for (const name of QUARTET) {
    assert.ok(
      names.includes(name),
      `the contract must declare \`${name}\`, got ${names.join(",")}`
    );
  }
  // The legacy placeholder is additive: the upstream accepts extra tools alongside the
  // quartet, so an install that configured it keeps seeing it.
  assert.equal(new Set(names).size, names.length, "no duplicate entries");
});

test("the Responses surface declares the same quartet in its flat shape", () => {
  const body = applyFreeTierRequestContract(RESPONSES_BODY(), "openai-responses") as Record<
    string,
    unknown
  >;
  const tools = body.tools as Array<Record<string, unknown>>;
  const names = tools.map((tool) => String(tool.name));
  for (const name of QUARTET) {
    assert.ok(names.includes(name), `the Responses surface must declare \`${name}\``);
  }
  for (const tool of tools) {
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.parameters, "object");
  }
});

test("a caller's own tools are kept as they are, quartet added alongside", () => {
  const clientTools = [
    { type: "function", function: { name: "Bash", parameters: { type: "object" } } },
    { type: "function", function: { name: "Read", parameters: { type: "object" } } },
  ];
  const body = applyFreeTierRequestContract(
    { ...CHAT_BODY(), tools: clientTools },
    "openai"
  ) as Record<string, unknown>;
  const names = chatToolNames(body);
  // The caller's own spelling is never renamed away — the upstream accepts extra entries and
  // the client must still recognise the names it declared (#15322).
  assert.ok(names.includes("Bash"));
  assert.ok(names.includes("Read"));
  for (const name of QUARTET) assert.ok(names.includes(name), `missing \`${name}\``);
});

test("applying the contract twice does not duplicate the quartet", () => {
  const once = applyFreeTierRequestContract(CHAT_BODY(), "openai") as Record<string, unknown>;
  const twice = applyFreeTierRequestContract(once, "openai") as Record<string, unknown>;
  const names = chatToolNames(twice);
  assert.equal(names.filter((name) => name === "bash").length, 1);
  assert.equal(
    names.length,
    chatToolNames(once).length,
    "idempotent: the second pass adds nothing"
  );
});

test("the refusal-retry merge also ends on the quartet", () => {
  const clientTools = [
    { type: "function", function: { name: "webfetch", parameters: { type: "object" } } },
  ];
  const merged = mergeClientToolsWithObserved(
    { ...CHAT_BODY(), tools: clientTools },
    "openai",
    "opencode-zen",
    "nemotron-3.5-lightning-free",
    undefined,
    []
  ) as Record<string, unknown>;
  const names = chatToolNames(merged);
  for (const name of QUARTET) assert.ok(names.includes(name), `missing \`${name}\``);
  assert.ok(names.includes("webfetch"), "the client's own tool stays declared");
});

test("prepareFreeTierRequest brings both standalone providers up to the quartet", () => {
  for (const provider of ["opencode", "opencode-zen"]) {
    const { body } = prepareFreeTierRequest(
      CHAT_BODY(),
      "openai",
      "zen",
      provider,
      "nemotron-3.5-lightning-free"
    );
    const names = chatToolNames(body);
    for (const name of QUARTET) {
      assert.ok(names.includes(name), `${provider}: missing \`${name}\``);
    }
    assert.equal((body as Record<string, unknown>).stream, true);
  }
});

test("a shape-valid session with a foreign encoding is re-minted inside the counter window", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headers,
    { "x-opencode-session": FOREIGN_SESSION },
    {
      synthesizeRequestId: true,
      cliDefaults: { userAgent: "opencode/1.18.31", client: "desktop", project: "global" },
      reencodeSession: true,
    }
  );
  const session = headers["x-opencode-session"];
  assert.notEqual(session, FOREIGN_SESSION, "a foreign encoding must not reach the gate");
  assert.match(session ?? "", OPENCODE_SESSION_PATTERN);
  assert.match(session ?? "", CANONICAL_SESSION_VALUE_RE);
});

test("re-minting is deterministic, so one conversation keeps one upstream session", () => {
  const once: Record<string, string> = {};
  const twice: Record<string, string> = {};
  const options = {
    synthesizeRequestId: true,
    cliDefaults: { userAgent: "opencode/1.18.31", client: "desktop", project: "global" },
    reencodeSession: true,
  };
  forwardOpencodeClientHeaders(once, { "x-opencode-session": FOREIGN_SESSION }, options);
  forwardOpencodeClientHeaders(twice, { "x-opencode-session": FOREIGN_SESSION }, options);
  assert.equal(once["x-opencode-session"], twice["x-opencode-session"]);
  // A different conversation keeps its own session (no single pinned identity).
  const other: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    other,
    { "x-opencode-session": "ses_0123456789abzyxwvutsrqponm" },
    options
  );
  assert.notEqual(other["x-opencode-session"], once["x-opencode-session"]);
});

test("a genuine descending session is kept verbatim", () => {
  const first: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    first,
    {},
    {
      synthesizeRequestId: true,
      cliDefaults: { userAgent: "opencode/1.18.31", client: "desktop", project: "global" },
      reencodeSession: true,
    }
  );
  const minted = first["x-opencode-session"] ?? "";
  assert.match(minted, CANONICAL_SESSION_VALUE_RE, "a synthesized id must satisfy the value gate");

  const second: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    second,
    { "x-opencode-session": minted },
    {
      synthesizeRequestId: true,
      cliDefaults: { userAgent: "opencode/1.18.31", client: "desktop", project: "global" },
      reencodeSession: true,
    }
  );
  assert.equal(second["x-opencode-session"], minted, "no churn for an already-valid value");
});

test("outside the gate the caller's own session value is left alone (opencode-go)", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headers,
    { "x-opencode-session": FOREIGN_SESSION },
    {
      synthesizeRequestId: true,
      cliDefaults: { userAgent: "opencode/1.18.31", client: "desktop", project: "global" },
      reencodeSession: false,
    }
  );
  assert.equal(headers["x-opencode-session"], FOREIGN_SESSION);
});

test("buildHeaders: the executor re-encodes a foreign session on a gated model only", () => {
  const gated = new OpencodeExecutor("opencode-zen").buildHeaders(
    null,
    false,
    { "x-opencode-session": FOREIGN_SESSION },
    "nemotron-3.5-lightning-free"
  );
  assert.match(gated["x-opencode-session"] ?? "", CANONICAL_SESSION_VALUE_RE);

  const paid = new OpencodeExecutor("opencode-zen").buildHeaders(
    null,
    false,
    { "x-opencode-session": FOREIGN_SESSION },
    "gpt-5.6-luna"
  );
  assert.equal(paid["x-opencode-session"], FOREIGN_SESSION);
});

test("buildHeaders: the noauth `opencode` provider is gated the same way", () => {
  const headers = new OpencodeExecutor("opencode").buildHeaders(
    null,
    false,
    { "x-opencode-session": FOREIGN_SESSION },
    "big-pickle"
  );
  assert.match(headers["x-opencode-session"] ?? "", CANONICAL_SESSION_VALUE_RE);
});

test("a standalone tool-less request leaves with all four legs of the contract", async () => {
  // The reproduction, end to end: a generic client (no OpenCode CLI) asks for a free model,
  // sends no tools and no OpenCode headers, and the executor has to bring the request up to
  // the upstream contract by itself — the quartet, the streaming flag, the UA and a session
  // whose value the gate decodes.
  const executor = new OpencodeExecutor("opencode");
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: new Headers((init?.headers as HeadersInit) ?? {}),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const sse =
      'data: {"id":"gen-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
      'data: {"id":"gen-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof globalThis.fetch;

  try {
    const result = (await executor.execute({
      model: "big-pickle",
      body: { model: "big-pickle", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      signal: null,
      credentials: { apiKey: null, accessToken: null, connectionId: "c" },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    })) as { response: Response };

    assert.equal(result.response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://opencode.ai/zen/v1/chat/completions");
    // Body legs: streamed, and every quartet name declared.
    assert.equal(seen[0].body.stream, true);
    const names = chatToolNames(seen[0].body);
    for (const name of QUARTET) assert.ok(names.includes(name), `missing \`${name}\``);
    // Header legs: a decodable session and a UA the gate accepts.
    assert.match(seen[0].headers.get("x-opencode-session") ?? "", CANONICAL_SESSION_VALUE_RE);
    assert.match(seen[0].headers.get("user-agent") ?? "", /^opencode\/\d+\.\d+/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
