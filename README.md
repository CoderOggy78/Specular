# AgentLens — Interceptor Proxy

OpenAI-compatible proxy that logs every agentic session to JSONL for downstream eval.

## Quick start

```bash
npm install

# Point at the real OpenAI API
AGENTLENS_TARGET=https://api.openai.com \
AGENTLENS_SESSION=my_session \
AGENTLENS_VERBOSE=1 \
node proxy.js
```

Then route your agent's OpenAI client at `http://localhost:4000` instead of `api.openai.com`.  
Works with any OpenAI-compatible API (Claude via openai compat, Ollama, etc).

## Environment variables

| Variable               | Default                    | Description                          |
|------------------------|----------------------------|--------------------------------------|
| `AGENTLENS_TARGET`     | `https://api.openai.com`   | Upstream API base URL                |
| `AGENTLENS_PORT`       | `4000`                     | Local proxy port                     |
| `AGENTLENS_SESSION`    | `session_<timestamp>`      | Session ID (used as trace filename)  |
| `AGENTLENS_TRACE_DIR`  | `./traces`                 | Directory to write JSONL traces      |
| `AGENTLENS_VERBOSE`    | `0`                        | Set to `1` for live console output   |

## Trace reader

```bash
node reader.js list                        # list all sessions
node reader.js inspect <session.jsonl>     # pretty-print every event
node reader.js stats   <session.jsonl>     # token + latency summary
```

## Trace format (JSONL)

Each line is one JSON event. Types:

- `session_start` / `session_end` — bookends
- `request` — full message array, model, tools declared, stream flag
- `response` — duration_ms, finish_reason, token usage, tool_calls made, content preview
- `request_error` / `response_error` — upstream failures with error detail

## Dev / test

```bash
node mock-upstream.js   # fake OpenAI on :5000
node test-run.js        # fires 4 scenarios through proxy, verifies trace
```

## What's next (eval engine)

The JSONL trace is the input contract for the scoring layer:
- `task_completion` — did finish_reason reach `stop`?
- `tool_efficiency` — tool_calls / total_requests
- `hallucination_signal` — LLM-as-judge on content
- `reasoning_coherence` — embedding drift across messages
- `latency_profile` — p50/p95 per model
