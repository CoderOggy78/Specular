import express from "express";
import { createServer } from "http";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARGET_BASE  = process.env.AGENTLENS_TARGET  || "https://api.openai.com";
const PROXY_PORT   = parseInt(process.env.AGENTLENS_PORT  || "4000", 10);
const TRACE_DIR    = process.env.AGENTLENS_TRACE_DIR || path.join(__dirname, "traces");
const SESSION_ID   = process.env.AGENTLENS_SESSION  || `session_${Date.now()}`;
const VERBOSE      = process.env.AGENTLENS_VERBOSE === "1";

fs.mkdirSync(TRACE_DIR, { recursive: true });

const TRACE_FILE = path.join(TRACE_DIR, `${SESSION_ID}.jsonl`);
const traceStream = fs.createWriteStream(TRACE_FILE, { flags: "a" });

function writeEvent(event) {
  traceStream.write(JSON.stringify(event) + "\n");
  if (VERBOSE) {
    const tag = `[${event.type}]`.padEnd(22);
    const info = event.model
      ? `model=${event.model}`
      : event.status_code
      ? `status=${event.status_code}`
      : event.error
      ? `error=${event.error}`
      : "";
    console.log(`  ${tag} ${info}`);
  }
}

writeEvent({
  type: "session_start",
  session_id: SESSION_ID,
  target: TARGET_BASE,
  trace_file: TRACE_FILE,
  ts: Date.now(),
});

const app = express();
app.use(express.raw({ type: "*/*", limit: "50mb" }));

app.use(async (req, res) => {
  const requestId = uuid();
  const tsStart   = Date.now();

  let requestBody = null;
  let parsedBody  = null;

  if (req.body?.length) {
    requestBody = req.body.toString("utf8");
    try { parsedBody = JSON.parse(requestBody); } catch { /* binary */ }
  }

  const isChat      = req.path === "/v1/chat/completions";
  const isStreaming = parsedBody?.stream === true;

  writeEvent({
    type: "request",
    request_id: requestId,
    session_id: SESSION_ID,
    ts: tsStart,
    method: req.method,
    path: req.path,
    model: parsedBody?.model,
    stream: isStreaming,
    messages: isChat
      ? (parsedBody?.messages || []).map(m => ({
          role: m.role,
          content: typeof m.content === "string"
            ? m.content.slice(0, 500)
            : m.content,
          tool_calls: m.tool_calls,
          tool_call_id: m.tool_call_id,
        }))
      : undefined,
    tools: parsedBody?.tools?.map(t => t?.function?.name || t?.name),
    temperature: parsedBody?.temperature,
    max_tokens: parsedBody?.max_tokens,
  });

  const targetUrl = `${TARGET_BASE}${req.path}`;

  const upstreamHeaders = {
    ...req.headers,
    host: new URL(TARGET_BASE).host,
  };
  delete upstreamHeaders["content-length"];

  let upstreamRes;
  try {
    upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: requestBody || undefined,
    });
  } catch (err) {
    writeEvent({
      type: "request_error",
      request_id: requestId,
      session_id: SESSION_ID,
      ts: Date.now(),
      error: err.message,
      duration_ms: Date.now() - tsStart,
    });
    res.status(502).json({ error: "upstream_unreachable", message: err.message });
    return;
  }

  const statusCode    = upstreamRes.status;
  const responseHdrs  = Object.fromEntries(upstreamRes.headers.entries());

  for (const [k, v] of Object.entries(responseHdrs)) {
    if (!["content-encoding", "transfer-encoding", "connection"].includes(k)) {
      res.setHeader(k, v);
    }
  }
  res.status(statusCode);

  if (isStreaming && statusCode === 200) {
    const chunks = [];
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();

    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const text = decoder.decode(value, { stream: !done });
        res.write(value);
        chunks.push(text);
      }
    }
    res.end();

    const raw = chunks.join("");
    const events = raw
      .split("\n")
      .filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);

    const deltaText = events
      .flatMap(e => e.choices || [])
      .map(c => c.delta?.content || "")
      .join("");

    const toolCalls = events
      .flatMap(e => e.choices || [])
      .filter(c => c.delta?.tool_calls)
      .map(c => c.delta.tool_calls)
      .flat();

    const lastEvent = events[events.length - 1] || {};

    writeEvent({
      type: "response",
      request_id: requestId,
      session_id: SESSION_ID,
      ts: Date.now(),
      duration_ms: Date.now() - tsStart,
      status_code: statusCode,
      stream: true,
      model: lastEvent.model || parsedBody?.model,
      finish_reason: lastEvent.choices?.[0]?.finish_reason,
      content_preview: deltaText.slice(0, 500),
      content_length: deltaText.length,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      usage: lastEvent.usage,
    });

  } else {
    const bodyBuf = Buffer.from(await upstreamRes.arrayBuffer());
    res.end(bodyBuf);

    let parsed = null;
    try { parsed = JSON.parse(bodyBuf.toString("utf8")); } catch { /* binary */ }

    const choice = parsed?.choices?.[0];

    writeEvent({
      type: statusCode < 400 ? "response" : "response_error",
      request_id: requestId,
      session_id: SESSION_ID,
      ts: Date.now(),
      duration_ms: Date.now() - tsStart,
      status_code: statusCode,
      stream: false,
      model: parsed?.model || parsedBody?.model,
      finish_reason: choice?.finish_reason,
      content_preview: choice?.message?.content?.slice(0, 500),
      content_length: choice?.message?.content?.length,
      tool_calls: choice?.message?.tool_calls,
      usage: parsed?.usage,
      error: parsed?.error,
    });
  }
});

const server = createServer(app);

server.listen(PROXY_PORT, () => {
  console.log(`\n  AgentLens interceptor running`);
  console.log(`  Proxy   : http://localhost:${PROXY_PORT}`);
  console.log(`  Target  : ${TARGET_BASE}`);
  console.log(`  Session : ${SESSION_ID}`);
  console.log(`  Trace   : ${TRACE_FILE}\n`);
});

process.on("SIGINT", () => {
  writeEvent({
    type: "session_end",
    session_id: SESSION_ID,
    ts: Date.now(),
  });
  traceStream.end(() => {
    console.log(`\n  Session closed. Trace saved: ${TRACE_FILE}`);
    process.exit(0);
  });
});
