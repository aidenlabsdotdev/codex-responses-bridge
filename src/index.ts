// HTTP server entry point. Two routes:
//   POST /v1/responses    — translate Responses → Chat, forward upstream,
//                           translate response back. Streaming and non-
//                           streaming both supported (codex-rs always
//                           sends stream:true; the JSON branch is kept
//                           for completeness and other Responses-API
//                           clients).
//   GET  /v1/models       — pass through to upstream so codex-sdk's
//                           preflight succeeds.
//
// Anything else → 404 with a clear message. We deliberately do NOT
// passthrough /v1/chat/completions: that would conflict with this
// bridge's role (clients that speak chat-completions natively should
// hit the upstream directly).

import * as http from "node:http";
import {
  BridgeError,
  PORT,
  OPENAI_BASE_URL,
  log,
} from "./config.ts";

import {
  buildSseEvents,
  chatToResponses,
  responsesToChat,
  type ChatRequest,
  type ResponsesRequest,
} from "./translate.ts";

// Pull the caller's Authorization header verbatim. Bridge has no key of
// its own — clients (codex etc.) supply their own credentials. Node's
// IncomingHttpHeaders types `authorization` as `string | undefined`, but
// we widen the access here so any unexpected `string[]` (rare but
// permissible by the HTTP spec) is also handled.
function authHeader(req: http.IncomingMessage): string {
  const v: unknown = req.headers["authorization"];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return "";
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleResponses(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let parsed: ResponsesRequest;
  try {
    parsed = JSON.parse(body) as ResponsesRequest;
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `bad JSON: ${e}` } }));
    return;
  }

  const wantsStream = parsed.stream === true;

  let chatReq: ChatRequest;
  let bareToNamespace: Map<string, string>;
  try {
    const result = responsesToChat(parsed);
    chatReq = result.chat;
    bareToNamespace = result.bareToNamespace;
  } catch (e) {
    if (e instanceof BridgeError) {
      log.info(`bridge error ${e.status}: ${e.message}`);
      res.writeHead(e.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: e.message, type: "bridge_error" } }),
      );
      return;
    }
    throw e;
  }

  // Upstream call is always non-streaming; we synthesize the SSE event
  // stream after the full response is in hand. This is the simplest
  // implementation and codex-rs accepts it transparently.
  chatReq.stream = false;
  log.debug(
    `responses → chat: ${chatReq.messages.length} messages, ` +
      `tools=${chatReq.tools?.length ?? 0}, model=${chatReq.model}, client_stream=${wantsStream}`,
  );

  const upstream = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader(req),
    },
    body: JSON.stringify(chatReq),
  });

  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    log.error(`upstream ${upstream.status}: ${upstreamText.slice(0, 400)}`);
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(upstreamText);
    return;
  }

  let chat;
  try {
    chat = JSON.parse(upstreamText);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: `upstream returned non-JSON: ${e}` },
      }),
    );
    return;
  }

  const reqModel = parsed.model ?? "";
  const reqMetadata = parsed.metadata;

  if (wantsStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const { events } = buildSseEvents(chat, reqModel, reqMetadata, bareToNamespace);
    let seq = 0;
    for (const ev of events) {
      // OpenAI Responses-SSE format: each event repeats the type and a
      // sequence_number inside the data payload. codex-rs parses on
      // data.type, so this is load-bearing.
      const dataWithType = {
        type: ev.event,
        sequence_number: seq++,
        ...(ev.data as Record<string, unknown>),
      };
      res.write(`event: ${ev.event}\n`);
      res.write(`data: ${JSON.stringify(dataWithType)}\n\n`);
    }
    res.end();
    return;
  }

  const responsesPayload = chatToResponses(chat, reqModel, reqMetadata, bareToNamespace);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(responsesPayload));
}

async function handleModels(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const upstream = await fetch(`${OPENAI_BASE_URL}/models`, {
    headers: { authorization: authHeader(req) },
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { "content-type": "application/json" });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  log.info(`${req.method} ${path}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "POST" && path === "/v1/responses") {
    handleResponses(req, res).catch((e) => {
      log.error("handler crashed:", e);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    });
    return;
  }

  if (req.method === "GET" && path === "/v1/models") {
    handleModels(req, res).catch((e) => {
      log.error("models handler crashed:", e);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    });
    return;
  }

  res.writeHead(404, {
    "content-type": "application/json",
    allow: "POST /v1/responses, GET /v1/models",
  });
  res.end(JSON.stringify({ error: { message: `unknown path: ${path}` } }));
});

server.listen(PORT, () => {
  log.info(`listening on :${PORT}, upstream=${OPENAI_BASE_URL}`);
});
