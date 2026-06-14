import express from "express";

const app = express();
app.use(express.json());

const TOOLS = ["read_file", "write_file", "run_bash", "search_codebase"];

app.post("/v1/chat/completions", (req, res) => {
  const { stream, model = "gpt-4o", messages = [] } = req.body;
  const lastMsg = messages[messages.length - 1]?.content || "";

  const scenarios = [
    {
      match: /fix|bug|error/i,
      finish: "tool_calls",
      tool: "read_file",
      args: { path: "src/main.py" },
      content: null,
    },
    {
      match: /write|create|generate/i,
      finish: "tool_calls",
      tool: "write_file",
      args: { path: "src/output.py", content: "# generated" },
      content: null,
    },
    {
      match: /.*/,
      finish: "stop",
      tool: null,
      content: `I've analyzed the request: "${lastMsg.slice(0, 60)}". Here is my response with relevant code changes and explanations for the implementation.`,
    },
  ];

  const scenario = scenarios.find(s => s.match.test(lastMsg)) || scenarios[0];
  const requestId = `chatcmpl-mock-${Date.now()}`;

  const usage = {
    prompt_tokens: Math.floor(100 + Math.random() * 200),
    completion_tokens: Math.floor(50 + Math.random() * 150),
    total_tokens: 0,
  };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    if (scenario.finish === "tool_calls") {
      send({
        id: requestId, object: "chat.completion.chunk", model,
        choices: [{ index: 0, delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function",
            function: { name: scenario.tool, arguments: JSON.stringify(scenario.args) } }]
        }, finish_reason: null }]
      });
    } else {
      const words = scenario.content.split(" ");
      for (const word of words) {
        send({ id: requestId, object: "chat.completion.chunk", model,
          choices: [{ index: 0, delta: { content: word + " " }, finish_reason: null }] });
      }
    }

    send({
      id: requestId, object: "chat.completion.chunk", model,
      choices: [{ index: 0, delta: {}, finish_reason: scenario.finish }],
      usage,
    });

    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    res.json({
      id: requestId, object: "chat.completion", model,
      choices: [{
        index: 0,
        message: scenario.finish === "tool_calls"
          ? { role: "assistant", content: null,
              tool_calls: [{ id: `call_${Date.now()}`, type: "function",
                function: { name: scenario.tool, arguments: JSON.stringify(scenario.args) } }] }
          : { role: "assistant", content: scenario.content },
        finish_reason: scenario.finish,
      }],
      usage,
    });
  }
});

app.listen(5000, () => console.log("  Mock upstream on http://localhost:5000"));
