import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACE_DIR  = process.env.AGENTLENS_TRACE_DIR || path.join(__dirname, "traces");

const args = process.argv.slice(2);
const cmd  = args[0] || "list";

function loadTrace(file) {
  const full = path.isAbsolute(file) ? file : path.join(TRACE_DIR, file);
  return fs.readFileSync(full, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

function listTraces() {
  if (!fs.existsSync(TRACE_DIR)) { console.log("No traces yet."); return; }
  const files = fs.readdirSync(TRACE_DIR).filter(f => f.endsWith(".jsonl"));
  if (!files.length) { console.log("No traces found in", TRACE_DIR); return; }
  console.log(`\n  Traces in ${TRACE_DIR}:\n`);
  for (const f of files) {
    const events = loadTrace(f);
    const reqs   = events.filter(e => e.type === "request").length;
    const errs   = events.filter(e => e.type === "response_error" || e.type === "request_error").length;
    const start  = events[0]?.ts ? new Date(events[0].ts).toISOString() : "?";
    const tokens = events.filter(e => e.usage).reduce((acc, e) => acc + (e.usage?.total_tokens || 0), 0);
    console.log(`  ${f}`);
    console.log(`    started=${start}  requests=${reqs}  errors=${errs}  tokens=${tokens}\n`);
  }
}

function inspectTrace(file) {
  const events = loadTrace(file);
  console.log(`\n  Trace: ${file}  (${events.length} events)\n`);

  for (const e of events) {
    const ts = e.ts ? new Date(e.ts).toISOString().slice(11, 23) : "?";
    const pad = (s, n) => String(s).padEnd(n);

    switch (e.type) {
      case "session_start":
        console.log(`  ${ts}  SESSION START  session=${e.session_id}`);
        break;
      case "session_end":
        console.log(`  ${ts}  SESSION END`);
        break;
      case "request":
        console.log(`  ${ts}  ▶ REQUEST      [${e.request_id.slice(0,8)}] ${pad(e.method,6)} ${e.path}`);
        console.log(`            model=${e.model || "?"}  stream=${e.stream}  tools=[${(e.tools||[]).join(",")}]`);
        if (e.messages?.length) {
          const last = e.messages[e.messages.length - 1];
          const preview = typeof last.content === "string" ? last.content.slice(0, 100) : "[structured]";
          console.log(`            last_msg role=${last.role}: ${preview}`);
        }
        break;
      case "response":
        console.log(`  ${ts}  ◀ RESPONSE     [${e.request_id.slice(0,8)}] status=${e.status_code}  ${e.duration_ms}ms`);
        console.log(`            finish=${e.finish_reason || "?"}  tokens=${JSON.stringify(e.usage || {})}`);
        if (e.tool_calls?.length) {
          console.log(`            tool_calls: ${e.tool_calls.map(t => t.function?.name || "?").join(", ")}`);
        }
        if (e.content_preview) {
          console.log(`            content: ${e.content_preview.slice(0, 120)}…`);
        }
        break;
      case "response_error":
      case "request_error":
        console.log(`  ${ts}  ✗ ERROR        [${e.request_id?.slice(0,8) || "?"}] ${JSON.stringify(e.error)}`);
        break;
    }
    console.log();
  }
}

function statsTrace(file) {
  const events = loadTrace(file);
  const reqs   = events.filter(e => e.type === "request");
  const resps  = events.filter(e => e.type === "response");
  const errs   = events.filter(e => e.type.includes("error"));

  const durations   = resps.map(e => e.duration_ms).filter(Boolean);
  const totalTokens = resps.reduce((a, e) => a + (e.usage?.total_tokens || 0), 0);
  const promptTok   = resps.reduce((a, e) => a + (e.usage?.prompt_tokens || 0), 0);
  const compTok     = resps.reduce((a, e) => a + (e.usage?.completion_tokens || 0), 0);
  const toolCalls   = resps.filter(e => e.tool_calls?.length);
  const models      = [...new Set(reqs.map(e => e.model).filter(Boolean))];
  const avgDur      = durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : 0;
  const p95Dur      = durations.length ? durations.sort((a,b)=>a-b)[Math.floor(durations.length*0.95)] : 0;

  console.log(`\n  Stats: ${file}\n`);
  console.log(`  Requests       : ${reqs.length}`);
  console.log(`  Responses      : ${resps.length}`);
  console.log(`  Errors         : ${errs.length}`);
  console.log(`  Models used    : ${models.join(", ") || "?"}`);
  console.log(`  Avg latency    : ${avgDur}ms`);
  console.log(`  p95 latency    : ${p95Dur}ms`);
  console.log(`  Tool-call reqs : ${toolCalls.length}`);
  console.log(`  Total tokens   : ${totalTokens}`);
  console.log(`    prompt       : ${promptTok}`);
  console.log(`    completion   : ${compTok}`);
  console.log(`  Tool efficiency: ${reqs.length ? (toolCalls.length / reqs.length * 100).toFixed(1) : 0}% of calls used tools\n`);
}

if (cmd === "list")              listTraces();
else if (cmd === "inspect")      inspectTrace(args[1]);
else if (cmd === "stats")        statsTrace(args[1]);
else {
  console.log(`
  Usage:
    node reader.js list
    node reader.js inspect <session.jsonl>
    node reader.js stats   <session.jsonl>
  `);
}
