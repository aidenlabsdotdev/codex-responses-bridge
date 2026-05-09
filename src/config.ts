// Centralized env-var parsing.
//
// Required:
//   OPENAI_BASE_URL   Upstream chat-completions root, e.g.
//                     http://localhost:4000/v1 (LiteLLM proxy) or
//                     https://api.openai.com/v1. No default — the bridge
//                     errors and exits if this isn't set; the wrong
//                     upstream is worse than no upstream.
//
// Optional:
//   PORT              Listen port. Default 4001 (one above the LiteLLM
//                     default of 4000, so common sibling-deployments
//                     don't conflict out of the box).
//   LOG_LEVEL         error | info | debug. Default info.
//
// Auth: the bridge does NOT hold an upstream API key. It forwards the
// caller's `Authorization` header verbatim to the upstream. Configure
// authentication at the client (e.g. set OPENAI_API_KEY on codex's
// model_provider) — the bridge is a pure translator and stays
// credential-free.
//
// The bridge is also a pure translator on the body side: model name,
// sampling parameters, tool definitions, and everything else flow
// through unchanged. Choose your model and sampling at the client.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n)) return n;
  console.error(`bridge: ${name}="${raw}" is not an integer; using ${fallback}`);
  return fallback;
}

export const PORT = envInt("PORT", 4001);

const _baseUrl = process.env.OPENAI_BASE_URL;
if (!_baseUrl) {
  console.error(
    "bridge: OPENAI_BASE_URL must be set (e.g. http://localhost:4000/v1 for a LiteLLM sibling, " +
      "or https://api.openai.com/v1 for OpenAI proper). The bridge has no default upstream because " +
      "the wrong upstream silently routing requests is worse than crashing on startup.",
  );
  process.exit(1);
}
export const OPENAI_BASE_URL = _baseUrl;

export const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();

export const log = {
  info: (...a: unknown[]): void => {
    if (LOG_LEVEL !== "error") console.error("[bridge]", ...a);
  },
  debug: (...a: unknown[]): void => {
    if (LOG_LEVEL === "debug") console.error("[bridge:debug]", ...a);
  },
  error: (...a: unknown[]): void => {
    console.error("[bridge:error]", ...a);
  },
};

export class BridgeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}
