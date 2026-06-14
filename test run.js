import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION = `test_${Date.now()}`;
const TRACE_DIR = path.join(__dirname, "traces");

console.log("\n  AgentLens end-to-end test\n");

const mock = spawn("node", ["mock-upstream.js"], { stdio: "pipe" });
await sleep(400);

const proxy = spawn("node", ["proxy.js"], {
  env: {
    ...process.env,
    AGENTLENS_TARGET: "http://localhost:5000",
    AGENTLENS_PORT: "4001",
    AGENTLENS_SESSION: SESSION,
    AGENTLENS_TRACE_DIR: TRACE_DIR,
    AGENTLENS_VERBOSE: "1",
  },
  stdio: "pipe",
});
await sleep(600);

proxy.stdout.on("data", d => process.stdout.write(d));
proxy.stderr.on("data", d => process.stderr.write(d));

const BASE = "http://localhost:4001";

async function callProxy(label, body) {
  console.log(`  → ${label}`);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer test-key" },
    body: JSON.stringify(body),
  });
  if (body.stream) {
    const text = await res.text();
    const lines = text.split("\n").filter(l => l.startsWith("data:") && l !== "data: [DONE]");
    const deltas = lines.map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
    const content = deltas.flatMap(d => d.choices || []).map(c => c.delta?.content || "").join("");
    console.log(`    streamed ${lines.length} chunks, content: "${content.slice(0,60)}..."`);
  } else {
    const data = await res.json();
    const choice = data.choices?.[0];
    if (choice?.message?.tool_calls) {
      console.log(`    tool_call: ${choice.message.tool_calls[0].function.name}`);
    } else {
      console.log(`    content: "${choice?.message?.content?.slice(0,60)}..."`);
    }
  }
}

await callProxy("non-streaming chat", {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Explain the bug in my auth module" }],
});
await sleep(200);

await callProxy("streaming chat", {
  model: "gpt-4o",
  stream: true,
  messages: [{ role: "user", content: "Generate a Python class for database connection" }],
});
await sleep(200);

await callProxy("tool-call scenario", {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Fix the error in my pipeline" }],
  tools: [
    { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    { type: "function", function: { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } },
  ],
});
await sleep(200);

await callProxy("streaming tool call", {
  model: "gpt-4o",
  stream: true,
  messages: [{ role: "user", content: "Write a config file for me" }],
  tools: [
    { type: "function", function: { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  ],
});
await sleep(500);

proxy.kill("SIGINT");
mock.kill("SIGINT");
await sleep(600);

const traceFile = path.join(TRACE_DIR, `${SESSION}.jsonl`);
const events = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));

console.log(`\n  Trace written: ${traceFile}`);
console.log(`  Total events : ${events.length}`);
console.log(`  Requests     : ${events.filter(e => e.type === "request").length}`);
console.log(`  Responses    : ${events.filter(e => e.type === "response").length}`);
console.log(`  Tool calls   : ${events.filter(e => e.tool_calls?.length).length}`);
console.log(`  Total tokens : ${events.filter(e => e.usage).reduce((a, e) => a + (e.usage?.total_tokens || 0), 0)}`);
console.log("\n  All checks passed.\n");
