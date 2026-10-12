#!/usr/bin/env node
// Optional installed-harness check. All completions come from a loopback fixture;
// this verifies adapter wiring, never model capability or provider inference.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter } from "../dist/harness.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "spillway-wire-")));
await chmod(root, 0o700);
const adapter = new OpenCodeAdapter(process.argv[2] ?? "opencode");
const model = "spillway-wire-fixture";
let active = 0;
let peak = 0;
let mode = "worker";
let requests = [];
const server = createServer((request, response) => {
  response.on("error", () => {});
  void handleRequest(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(400);
    response.end();
  });
});
async function handleRequest(request, response) {
  if (request.method === "GET") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: model }] }));
    return;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.tools) || body.tools.length > 100 ||
      body.tools.some((tool) => typeof tool?.function?.name !== "string")) {
    response.writeHead(400).end();
    return;
  }
  requests.push({ path: request.url, model: body.model, temperature: body.temperature, tools: body.tools.map((tool) => tool.function.name) });
  active++;
  try {
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const content = mode === "review"
      ? JSON.stringify({ resultSha: "a".repeat(40), verdict: "accept", findings: [] })
      : "OK";
    const chunk = {
      id: "fixture-completion", object: "chat.completion.chunk", created: 1,
      model, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.write(`data: ${JSON.stringify({
      ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  } finally {
    active--;
  }
}
try {
  const version = await adapter.version();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  for (mode of ["worker", "review"]) {
    requests = [];
    peak = 0;
    const worktree = join(root, mode, "repo");
    const artifacts = join(root, mode, "artifacts");
    await mkdir(worktree, { recursive: true, mode: 0o700 });
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const result = await adapter.run({
      worktree, logPath: join(artifacts, "worker.log"), purpose: mode,
      prompt: "Return the requested fixture response without using tools.",
      timeoutSec: 30, temperature: 0,
      endpoint: { id: "fixture", kind: "local", url: `http://127.0.0.1:${port}/v1` },
      profile: {
        id: "fixture", endpoint: "fixture", model, model_artifact: "fixture-only",
        harness: "opencode", harness_version: version, qualified_classes: ["mechanical"],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(result.exit, "completed", "Installed harness must complete the fixture");
    assert.equal(requests.length, 1, "Auxiliary completions must be disabled");
    assert.equal(peak, 1, "Only the primary completion may be active");
    const { tools, ...observed } = requests[0];
    assert.deepEqual(observed, { path: "/v1/chat/completions", model, temperature: 0 });
    assert.ok(tools.includes("read"), "Expected primary tools must be available");
    if (mode === "worker") assert.ok(!tools.some((tool) => ["task", "skill", "batch", "question", "plan_enter", "plan_exit"].includes(tool)), "Delegation tools must be absent");
    else assert.ok(tools.every((tool) => ["read", "glob", "grep"].includes(tool)), "Reviewer tools must be read-only");
    if (mode === "review") assert.equal(result.summary, JSON.stringify({ resultSha: "a".repeat(40), verdict: "accept", findings: [] }));
    process.stdout.write(`OpenCode ${version} ${mode}: one fixture request, temperature 0, completed.\n`);
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
