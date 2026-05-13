// Translation between OpenAI Responses API and Chat Completions.
//
// Outbound (request side):  responsesToChat — Responses → Chat
// Inbound  (response side): chatToResponses — Chat → Responses (one-shot)
//                           buildSseEvents  — Chat → Responses (SSE stream)
//
// Design rule: stay as lossless as possible. Every drop or rename has an
// inline comment justifying it. Anything that can't faithfully translate
// (background:true, previous_response_id pointing at server-state we
// don't have) raises a 400 instead of silently dropping.

import { randomUUID } from "node:crypto";
import { BridgeError } from "./config.ts";

// ─── types ────────────────────────────────────────────────────────────────

type ResponsesContentPart =
  | { type: "input_text" | "output_text" | "text"; text: string }
  | { type: "input_image"; image_url?: string | { url: string; detail?: string } }
  | { type: "input_audio"; input_audio?: { data: string; format: string } }
  | { type: "input_file"; filename?: string; file_data?: string; file_id?: string }
  | { type: string; [k: string]: unknown };

// Codex 0.117+ wraps MCP tools in a namespace container:
//   {type: "namespace", name: "mcp__chrome__", tools: [{type: "function", ...}, ...]}
// We lift the inner functions to top level so the chat-completions endpoint
// sees real callable tools instead of an opaque namespace placeholder.
type ResponsesNamespaceTool = {
  type: "namespace";
  name: string;
  description?: string;
  tools: { type: "function"; name: string; description?: string; parameters?: unknown }[];
};
type ResponsesFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters?: unknown;
};
type ResponsesTool = ResponsesFunctionTool | ResponsesNamespaceTool;

type ResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: ResponsesContentPart[] | string;
    }
  | {
      type: "reasoning";
      id?: string;
      content?: { type: string; text: string }[];
      summary?: { type: string; text: string }[];
      encrypted_content?: string | null;
    }
  | {
      type: "function_call";
      id?: string;
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

export interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: ResponsesInputItem[] | string;
  tools?: ResponsesTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string };
  text?: { format?: { type: "text" | "json_object" | "json_schema"; [k: string]: unknown } };
  user?: string;
  metadata?: Record<string, string>;
  store?: boolean;
  stream?: boolean;
  background?: boolean;
  previous_response_id?: string | null;
  truncation?: string;
  include?: string[];
  service_tier?: string;
  // Allow arbitrary extra fields (top_k, min_p, repetition_penalty, etc.)
  // to pass through. The type below is permissive on purpose.
  [k: string]: unknown;
}

interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  // Chat Completions allows content to be a string OR an array of typed
  // parts (text/image_url/input_audio) for multimodal input.
  content?: string | unknown[] | null;
  reasoning_content?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: { type: "function"; function: { name: string; description?: string; parameters?: unknown } }[];
  tool_choice?: ResponsesRequest["tool_choice"];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  parallel_tool_calls?: boolean;
  response_format?: unknown;
  user?: string;
  metadata?: Record<string, string>;
  stream?: boolean;
  [k: string]: unknown;
}

// ─── content translation ──────────────────────────────────────────────────

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

// Returns a plain string when every part is text-only; an array of typed
// parts when multimodal parts are present (vision-capable models use the
// array form).
function translateContent(
  content: ResponsesContentPart[] | string | undefined,
): string | ChatContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return "";

  const isText = (c: ResponsesContentPart): boolean =>
    c.type === "input_text" || c.type === "output_text" || c.type === "text";

  if (content.every(isText)) {
    return content.map((c) => (c as { text: string }).text ?? "").join("");
  }

  const parts: ChatContentPart[] = [];
  for (const c of content) {
    if (isText(c)) {
      parts.push({ type: "text", text: (c as { text: string }).text ?? "" });
    } else if (c.type === "input_image") {
      const raw = (c as { image_url?: unknown }).image_url;
      const url =
        typeof raw === "string" ? raw : (raw as { url?: string })?.url ?? "";
      const detail = (raw as { detail?: string })?.detail;
      parts.push({
        type: "image_url",
        image_url: { url, ...(detail ? { detail } : {}) },
      });
    } else if (c.type === "input_audio") {
      const audio = (c as { input_audio?: { data: string; format: string } })
        .input_audio;
      if (audio) parts.push({ type: "input_audio", input_audio: audio });
    } else if (c.type === "input_file") {
      // Chat Completions has no standard file content part. Bail loudly so
      // the caller knows their attachment isn't getting through.
      const file = c as { filename?: string };
      throw new BridgeError(
        400,
        `input_file content not supported by the bridge (filename=${file.filename ?? "unnamed"}). ` +
          `Chat Completions has no standard 'file' content part.`,
      );
    } else {
      throw new BridgeError(
        400,
        `unsupported content type '${c.type}'; bridge only knows ` +
          `input_text/output_text/text/input_image/input_audio/input_file`,
      );
    }
  }
  return parts;
}

// String-only flattener for places where multimodal can't apply (reasoning
// text, tool result content, system/instructions strings).
function flattenText(
  content: ResponsesContentPart[] | string | undefined,
): string {
  const out = translateContent(content);
  if (typeof out === "string") return out;
  return out
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
}

// ─── Responses request → Chat Completions request ─────────────────────────

export function responsesToChat(req: ResponsesRequest): {
  chat: ChatRequest;
  bareToNamespace: Map<string, string>;
} {
  // Hard-error on Responses-API features that have no Chat Completions
  // equivalent and would silently produce wrong behavior if dropped.
  if (req.background === true) {
    throw new BridgeError(
      400,
      "background:true not supported — Chat Completions has no async/background mode; codex would hang waiting for a job ID we never produce",
    );
  }
  if (req.previous_response_id) {
    throw new BridgeError(
      400,
      `previous_response_id=${req.previous_response_id} not supported — the bridge has no server-side state; pass full conversation history in 'input' instead`,
    );
  }
  // store: silently fine to drop; we never persist anyway.
  // truncation: server-side strategy with no Chat equivalent — honoring it
  //   would require us to count tokens which we don't.
  // include: extra fields to include in the response — we already include
  //   everything we have.

  const messages: ChatMessage[] = [];

  // 1. instructions → leading system message. Responses has a top-level
  //    `instructions` string; Chat Completions doesn't, so we promote it
  //    to a system message at position 0.
  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }

  // 2. Walk input items. Two compositions happen here:
  //    a) reasoning items → reasoning_content on the next assistant
  //       message (LiteLLM's acompletion hook then renames to vLLM's
  //       `reasoning` field, which the chat template re-injects as a
  //       <think> block — preserve_thinking).
  //    b) consecutive function_call items belong to the SAME assistant
  //       turn (parallel tool calls); we coalesce them into one
  //       assistant message with tool_calls=[…all]. Splitting them into
  //       separate assistant messages would be invalid Chat Completions
  //       schema (no two assistant messages can be adjacent without an
  //       intervening tool/user message).
  let pendingReasoning: string | null = null;
  let pendingToolCalls: ChatMessage["tool_calls"] = undefined;

  function flushPendingToolCalls(): void {
    if (pendingToolCalls && pendingToolCalls.length) {
      const msg: ChatMessage = {
        role: "assistant",
        content: null,
        tool_calls: pendingToolCalls,
      };
      if (pendingReasoning) {
        msg.reasoning_content = pendingReasoning;
        pendingReasoning = null;
      }
      messages.push(msg);
      pendingToolCalls = undefined;
    }
  }

  const items: ResponsesInputItem[] = Array.isArray(req.input)
    ? req.input
    : req.input
      ? [{ type: "message", role: "user", content: req.input as string }]
      : [];

  for (const item of items) {
    if (item.type === "message") {
      flushPendingToolCalls();
      const role = item.role;
      if (role === "assistant") {
        // Assistant message content is text-only (output_text); flatten.
        const text = flattenText(item.content);
        const msg: ChatMessage = { role: "assistant", content: text };
        if (pendingReasoning) {
          msg.reasoning_content = pendingReasoning;
          pendingReasoning = null;
        }
        messages.push(msg);
      } else {
        // user / system / developer pass through with original role label.
        // Both OpenAI Chat Completions and the patched Qwen3.6 chat
        // template accept `developer` natively.
        const content = translateContent(item.content);
        messages.push({ role, content: content as string | unknown[] });
      }
    } else if (item.type === "reasoning") {
      // Concatenate full reasoning text into pendingReasoning. It will
      // attach to the next assistant message (function_call or message)
      // as reasoning_content. Drops: `summary[]` (Qwen3.6 doesn't produce
      // summaries — that's an OpenAI o-series feature), `encrypted_content`
      // (OpenAI-server-side only, opaque to self-hosted backends), and
      // the original item id (vLLM's chat template doesn't read it).
      const text = (item.content ?? []).map((c) => c.text ?? "").join("");
      pendingReasoning = (pendingReasoning ?? "") + text;
    } else if (item.type === "function_call") {
      // Coalesce parallel tool calls into a single assistant message.
      pendingToolCalls = pendingToolCalls ?? [];
      pendingToolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item.type === "function_call_output") {
      flushPendingToolCalls();
      // Tool result. Drops: any extra metadata (e.g., name); only call_id
      // and output content are part of the Chat Completions tool message.
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output,
      });
    }
    // Unknown item types fall through silently. If a real client emits
    // any others, the upstream call will fail informatively (chat
    // template error) and we can add a handler.
  }
  flushPendingToolCalls();

  // 3. Tools: namespace expansion + bare-name remapping + schema rename.
  //
  //    Codex 0.117+ wraps MCP tools in
  //    `{type: "namespace", name: "mcp__X__", tools: [{type: "function", ...}, ...]}`.
  //    Without expansion, downstream sees only an opaque placeholder and
  //    can't invoke MCP tools. We lift each inner function to top level
  //    using its BARE name (e.g. `browser_click`, not
  //    `mcp__chrome__browser_click`) because bare names are smaller in
  //    tokens and the model has likely seen them in training.
  //
  //    bareToNamespace tracks which namespace each bare name belongs to.
  //    On the response side we read it to restore (namespace, name) pairs
  //    on returned function_call items so codex's runtime can dispatch.
  //
  //    Collisions raise a 400 instead of silent last-wins.
  //
  //    Schema rename: Responses tool entries are flat
  //    `{type, name, description, parameters}`; Chat Completions wraps
  //    inside `function: {…}`.
  const tools: ChatRequest["tools"] = [];
  const bareToNamespace = new Map<string, string>();
  // Pass 1: namespaces — populate map first so pass 2 can detect builtins
  // shadowing namespaced names.
  for (const t of req.tools ?? []) {
    if (t.type !== "namespace" || !Array.isArray(t.tools)) continue;
    const ns = t.name;
    for (const inner of t.tools) {
      if (inner.type !== "function") continue;
      const bare = inner.name;
      const existing = bareToNamespace.get(bare);
      if (existing && existing !== ns) {
        throw new BridgeError(
          400,
          `tool name collision: '${bare}' exists in both '${existing}' and '${ns}' namespaces. ` +
            `Bridge uses bare names so the model sees natural tool names; rename one of the conflicting tools.`,
        );
      }
      bareToNamespace.set(bare, ns);
      tools.push({
        type: "function",
        function: {
          name: bare,
          description: inner.description,
          parameters: inner.parameters,
        },
      });
    }
  }
  // Pass 2: top-level function tools. Reject if their name collides with
  // anything we already lifted from a namespace.
  for (const t of req.tools ?? []) {
    if (t.type !== "function") continue;
    if (bareToNamespace.has(t.name)) {
      throw new BridgeError(
        400,
        `tool name collision: builtin tool '${t.name}' shadows a namespaced tool from '${bareToNamespace.get(t.name)}'. ` +
          `Bridge cannot disambiguate at dispatch time; rename the conflicting tool.`,
      );
    }
    tools.push({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    });
  }

  // 4. response_format: Responses uses `text.format = {type: ..., schema?}`.
  //    Chat Completions uses `response_format` at top level. Same shape,
  //    different position.
  const responseFormat = req.text?.format
    ? { ...(req.text.format as object) }
    : undefined;

  if (!req.model) {
    throw new BridgeError(
      400,
      "request is missing required field 'model'. The bridge passes the model through to the upstream; choose it at the client.",
    );
  }

  const chat: ChatRequest = {
    // Pass-through. The bridge is a pure translator; model selection is
    // the client's choice.
    model: req.model,
    messages,
  };
  if (tools.length) chat.tools = tools;
  // Only forward tool_choice when the request actually carries tools.
  // codex sends ``tool_choice: "auto"`` even on post-completion compaction
  // turns where it has stripped tools to ask the model for a plain text
  // summary.  vLLM (correctly) rejects ``tool_choice`` without a
  // ``tools`` array: "When using `tool_choice`, `tools` must be set."
  if (tools.length && req.tool_choice !== undefined) {
    chat.tool_choice = req.tool_choice;
  }

  // OpenAI-standard sampling params: pure pass-through.
  if (req.temperature !== undefined) chat.temperature = req.temperature;
  if (req.top_p !== undefined) chat.top_p = req.top_p;
  if (req.presence_penalty !== undefined)
    chat.presence_penalty = req.presence_penalty;
  if (req.frequency_penalty !== undefined)
    chat.frequency_penalty = req.frequency_penalty;

  // Vendor-specific extras (top_k, min_p, repetition_penalty, etc.) are
  // not in the OpenAI-spec ResponsesRequest type but pass through to the
  // upstream as-is if the client supplied them. OpenAI-compat backends
  // typically accept or ignore these (LiteLLM with drop_params, vLLM
  // accepts them as extra body params).
  const reqAny = req as Record<string, unknown>;
  for (const key of ["top_k", "min_p", "repetition_penalty"]) {
    if (typeof reqAny[key] === "number") {
      (chat as Record<string, unknown>)[key] = reqAny[key];
    }
  }

  // Rename: max_output_tokens (Responses) → max_tokens (Chat Completions).
  if (req.max_output_tokens !== undefined)
    chat.max_tokens = req.max_output_tokens;
  if (req.parallel_tool_calls !== undefined)
    chat.parallel_tool_calls = req.parallel_tool_calls;
  if (responseFormat) chat.response_format = responseFormat;
  if (req.user !== undefined) chat.user = req.user;
  if (req.metadata !== undefined) chat.metadata = req.metadata;
  if (req.reasoning !== undefined) chat.reasoning = req.reasoning;

  return { chat, bareToNamespace };
}

// ─── Chat finish_reason → Responses status ────────────────────────────────

function finishReasonToStatus(finishReason?: string): {
  status: "completed" | "incomplete" | "failed";
  incomplete_details: { reason: string } | null;
} {
  switch (finishReason) {
    case "length":
      return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    case "content_filter":
      return { status: "incomplete", incomplete_details: { reason: "content_filter" } };
    default:
      // stop, tool_calls, function_call, undefined, "" → assume normal completion.
      return { status: "completed", incomplete_details: null };
  }
}

// ─── Chat completion → Responses output items ─────────────────────────────
//
// Field shape matches codex-rs/protocol/src/models.rs `ResponseItem`:
// we emit only fields the deserializer reads. Extra fields (like
// `status`, `annotations`) get silently dropped by the deserializer, so
// we omit them.
function buildOutputItems(
  message: ChatMessage,
  bareToNamespace: Map<string, string>,
): unknown[] {
  const output: unknown[] = [];
  if (message.reasoning_content) {
    output.push({
      id: `rs_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      type: "reasoning",
      summary: [], // required (Vec, may be empty)
      content: [{ type: "reasoning_text", text: message.reasoning_content }],
      encrypted_content: null,
    });
  }
  if (message.content) {
    output.push({
      id: `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: typeof message.content === "string" ? message.content : "",
        },
      ],
    });
  }
  for (const tc of message.tool_calls ?? []) {
    // Restore namespace if the bare name was lifted from a namespace tool.
    // `namespace` IS a real codex-rs field on ResponseItem::FunctionCall.
    const bareName = tc.function.name;
    const namespace = bareToNamespace.get(bareName);
    const item: Record<string, unknown> = {
      id: `fc_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      type: "function_call",
      call_id: tc.id,
      name: bareName,
      arguments: tc.function.arguments,
    };
    if (namespace) item.namespace = namespace;
    output.push(item);
  }
  return output;
}

interface ChatCompletion {
  id?: string;
  created?: number;
  model?: string;
  choices?: { message: ChatMessage; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export function chatToResponses(
  chat: ChatCompletion,
  reqModel: string,
  reqMetadata: Record<string, string> | undefined,
  bareToNamespace: Map<string, string>,
): unknown {
  const message = chat.choices?.[0]?.message ?? { role: "assistant" };
  const { status, incomplete_details } = finishReasonToStatus(
    chat.choices?.[0]?.finish_reason,
  );
  const output = buildOutputItems(message, bareToNamespace);

  return {
    id: chat.id ?? `resp_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    object: "response",
    created_at: chat.created ?? Math.floor(Date.now() / 1000),
    status,
    incomplete_details,
    instructions: null,
    model: reqModel,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: chat.usage?.prompt_tokens ?? 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: chat.usage?.completion_tokens ?? 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: chat.usage?.total_tokens ?? 0,
    },
    metadata: reqMetadata ?? {},
  };
}

// ─── Synthetic SSE events for fake-streaming ──────────────────────────────
//
// codex-rs always sends `stream: true`, so the SSE path is the hot one.
// We wait for the full upstream response, then emit a synthetic event
// sequence. Implementation simplification — true delta-streaming would
// interleave with upstream chunks but is materially harder to get right.
// Functional behavior is identical from codex-rs's perspective; only the
// latency UX differs.
//
// Events we emit are exactly the five codex-rs's parser consumes:
//   response.created
//   response.output_item.added
//   response.output_text.delta              (for message items)
//   response.reasoning_text.delta           (for reasoning items)
//   response.custom_tool_call_input.delta   (for function_call items)
//   response.completed
// codex-rs ignores other event types in its match arm; we omit them.

export function buildSseEvents(
  chat: ChatCompletion,
  reqModel: string,
  reqMetadata: Record<string, string> | undefined,
  bareToNamespace: Map<string, string>,
): { events: { event: string; data: unknown }[] } {
  const message = chat.choices?.[0]?.message ?? { role: "assistant" };
  const { status: finalStatus, incomplete_details } = finishReasonToStatus(
    chat.choices?.[0]?.finish_reason,
  );
  const responseId = `resp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const events: { event: string; data: unknown }[] = [];
  const items = buildOutputItems(message, bareToNamespace);

  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: chat.created ?? Math.floor(Date.now() / 1000),
    status: "in_progress",
    incomplete_details: null,
    instructions: null,
    model: reqModel,
    output: [] as unknown[],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: null as unknown,
    metadata: reqMetadata ?? {},
  };

  events.push({ event: "response.created", data: { response: baseResponse } });

  let outputIndex = 0;
  for (const item of items) {
    const itm = item as Record<string, unknown>;
    events.push({
      event: "response.output_item.added",
      data: { output_index: outputIndex, item: itm },
    });
    if (itm.type === "message") {
      const text = ((itm.content as { text: string }[])?.[0]?.text as string) ?? "";
      events.push({
        event: "response.output_text.delta",
        data: {
          item_id: itm.id,
          output_index: outputIndex,
          content_index: 0,
          delta: text,
        },
      });
    } else if (itm.type === "reasoning") {
      const text = ((itm.content as { text: string }[])?.[0]?.text as string) ?? "";
      events.push({
        event: "response.reasoning_text.delta",
        data: {
          item_id: itm.id,
          output_index: outputIndex,
          content_index: 0,
          delta: text,
        },
      });
    } else if (itm.type === "function_call") {
      const args = (itm.arguments as string) ?? "";
      events.push({
        event: "response.custom_tool_call_input.delta",
        data: { item_id: itm.id, output_index: outputIndex, delta: args },
      });
    }
    events.push({
      event: "response.output_item.done",
      data: { output_index: outputIndex, item: itm },
    });
    outputIndex += 1;
  }

  const completed = {
    ...baseResponse,
    status: finalStatus,
    incomplete_details,
    output: items,
    usage: {
      input_tokens: chat.usage?.prompt_tokens ?? 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: chat.usage?.completion_tokens ?? 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: chat.usage?.total_tokens ?? 0,
    },
  };
  events.push({ event: "response.completed", data: { response: completed } });

  return { events };
}
