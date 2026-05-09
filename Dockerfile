# Multi-stage build keeps the final image small.
# Stage 1: install npm deps. Stage 2: copy source + node_modules.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

FROM node:22-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

# Run as non-root for safety. node:22-alpine ships a `node` user already.
RUN chown -R node:node /app
USER node

# Env vars the bridge reads (code defaults match these).
#
# Required for sensible behavior:
#   OPENAI_BASE_URL   Upstream chat-completions root, e.g.
#                     http://my-litellm:4000/v1 or https://api.openai.com/v1.
#                     No default — must be supplied at run time.
#
# Authentication: bridge has NO API key of its own. The caller's
# `Authorization` header is forwarded verbatim to the upstream. Set
# OPENAI_API_KEY (or whatever the upstream expects) on the *client*.
ENV PORT=8090
ENV LOG_LEVEL=info

EXPOSE 8090

# Lightweight TCP healthcheck via Node's built-in net module (no curl
# needed in the image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('net').connect(${PORT:-8090},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" \
   || exit 1

CMD ["npx", "tsx", "--experimental-strip-types", "src/index.ts"]
