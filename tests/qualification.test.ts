import { createServer } from "node:http";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  communityProjection,
  observeToolEvidence,
  qualificationMetadataSchema,
  runQualification,
  validateCommunityProfile,
  type QualificationMetadata,
} from "../src/qualification.js";
import { runProcess } from "../src/process.js";
import type {
  EndpointProfile,
  HarnessAdapter,
  ModelProfile,
} from "../src/contracts.js";

const complete: QualificationMetadata = {
  model: "fixture-model",
  modelArtifact: "a".repeat(64),
  harnessVersion: "1.2.3",
  serverVersion: "0.3.1",
  license: "Apache-2.0",
  contextTokens: 8192,
  hardware: { memoryGiB: 32, cpuCores: 8, gpuCount: 1, gpuMemoryGiB: 24 },
  serverEngine: "lm-studio",
  settings: {
    quantization: "Q4_K_M",
    temperature: 0,
    seed: null,
    concurrency: 1,
  },
};
const fixtureProgram = `
const fs=require('node:fs'),cp=require('node:child_process'); const scenario=process.argv[2]; let n=0;
const emit=(event)=>console.log(JSON.stringify(event)); const round=(id)=>emit({type:'step_start',part:{id}});
const tool=(name,input,exit=undefined,output='')=>emit({type:'tool_use',part:{id:'part-'+(++n),callID:'call-'+n,tool:name,state:{status:'completed',input,output,metadata:exit===undefined?{}:{exit}}}});
const command=(path)=>{let exit=0,output='';try{output=cp.execFileSync(process.execPath,[path],{stdio:'pipe',encoding:'utf8'});}catch(error){exit=error.status;output=String(error.stdout)+String(error.stderr);}tool('bash',{command:'node '+path},exit,output);};
round('round-one'); const inventory=fs.readFileSync('docs/inventory.json','utf8'); tool('read',{filePath:'docs/inventory.json'},undefined,inventory);
if(scenario==='discovery'){fs.readdirSync('docs');tool('glob',{pattern:'docs/**'});}
let ledger='';if(scenario==='read-search'||scenario==='multi-round'){if(scenario==='multi-round')round('round-two');ledger=fs.readFileSync('docs/ledger.jsonl','utf8');tool('grep',{pattern:'target-seven',path:'docs/ledger.jsonl'},undefined,ledger.split('\\n').filter(line=>line.includes('target-seven')).join('\\n'));if(scenario==='multi-round')tool('read',{filePath:'docs/ledger.jsonl'},undefined,ledger);}
if(scenario==='command')command('tools/echo.cjs');
if(scenario==='tool-error-recovery'){command('tools/failure.cjs');command('tools/recover.cjs');}
if(scenario==='test-driven-repair')command('checks/acceptance.cjs');
if(scenario==='multi-round')round('round-three');
const expected=scenario==='multi-round'?JSON.parse(ledger.split('\\n').find(line=>line.includes('target-seven'))).value:JSON.parse(fs.readFileSync('fixtures/expected.json','utf8')).value;
fs.writeFileSync('src/value.cjs','module.exports = () => ('+JSON.stringify(expected)+');\\n'); tool('edit',{filePath:'src/value.cjs'});
command('checks/acceptance.cjs');
cp.execFileSync('git',['-c','core.hooksPath=/dev/null','add','src/value.cjs'],{stdio:'pipe'});
cp.execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-m','Fixture-only source edit'],{stdio:'pipe'});
emit({type:'step_finish',part:{id:'final',reason:'stop'}});
`;
describe("fixed qualification workload through real Git and a fixture subprocess harness", () => {
  let root: string;
  let endpoint: EndpointProfile;
  let profile: ModelProfile;
  let calls: number;
  let catalog: ReturnType<typeof createServer>;
  let adapter: HarnessAdapter;
  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "spillway-qualification-")),
    );
    await chmod(root, 0o700);
    calls = 0;
    const executable = join(root, "fixture.cjs");
    await writeFile(executable, fixtureProgram);
    catalog = createServer((_request, response) => {
      response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    });
    await new Promise<void>((done) => catalog.listen(0, "127.0.0.1", done));
    const address = catalog.address();
    if (!address || typeof address === "string")
      throw new Error("Missing catalog port");
    endpoint = {
      id: "fixture",
      kind: "local",
      url: `http://127.0.0.1:${address.port}/v1`,
    };
    profile = {
      id: "fixture-profile",
      endpoint: "fixture",
      model: "fixture-model",
      model_artifact: complete.modelArtifact!,
      harness: "opencode",
      harness_version: "1.2.3",
      qualified_classes: ["mechanical"],
    };
    adapter = {
      id: "opencode",
      async version() {
        return "1.2.3";
      },
      async run(input) {
        expect(input.temperature).toBe(0);
        calls++;
        const scenario = /case ([a-z-]+)\./.exec(input.prompt)?.[1];
        if (!scenario) throw new Error("Unexpected arbitrary prompt");
        const run = await runProcess({
          command: process.execPath,
          args: [executable, scenario],
          cwd: input.worktree,
          timeoutMs: input.timeoutSec * 1000,
          logPath: input.logPath,
          signal: input.signal,
        });
        return {
          exit: run.timedOut
            ? "timeout"
            : run.exitCode === 0
              ? "completed"
              : "failed",
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      },
    };
  });
  afterEach(async () => {
    catalog.closeAllConnections();
    await new Promise<void>((done) => catalog.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  it("observes all seven cases and independent protected checks but never qualifies fixtures", async () => {
    const result = await runQualification({
      root: join(root, "run"),
      profile,
      endpoint,
      adapter,
      metadata: complete,
      provenance: "fixture",
    });
    expect(calls).toBe(7);
    expect(result.cases.map((row) => row.capability)).toEqual(CAPABILITIES);
    expect(
      result.cases.every(
        (row) =>
          row.outcome === "passed" &&
          row.verification?.passed &&
          row.observations.requirementsMet,
      ),
    ).toBe(true);
    expect(
      result.cases.every(
        (row) => row.usage?.inputTokens === 10 && row.contextBytes > 30000,
      ),
    ).toBe(true);
    expect(result.qualified).toBe(false);
    expect(
      result.cases.find((row) => row.capability === "multi-round")?.observations
        .contextBytesObserved,
    ).toBeGreaterThanOrEqual(32000);
    expect(
      await readFile(
        join(
          result.cases.find((row) => row.capability === "multi-round")!
            .worktree!,
          "docs/inventory.json",
        ),
        "utf8",
      ),
    ).not.toContain("multi-round-ready");
    expect(
      await readFile(
        join(
          result.cases.find((row) => row.capability === "multi-round")!
            .worktree!,
          "fixtures/expected.json",
        ),
        "utf8",
      ),
    ).not.toContain("multi-round-ready");
    expect(result.failures).toContain("fixture-provenance");
    expect(result.metadataComplete).toBe(true);
    expect(profile.qualified_classes).toEqual(["mechanical"]);
    expect(() => communityProjection(result, "fixture-profile")).toThrow();
    expect(() =>
      communityProjection(
        {
          ...result,
          provenance: "real",
          qualified: true,
          metadata: { ...result.metadata, model: "wrong-public-model" },
        },
        "example",
      ),
    ).toThrow();
    expect(
      JSON.parse(
        await readFile(join(root, "run", "qualification.json"), "utf8"),
      ) as unknown,
    ).toMatchObject({ provenance: "fixture", qualified: false });
    for (const row of result.cases)
      expect(
        await readFile(join(row.worktree!, "checks/acceptance.cjs"), "utf8"),
      ).toContain("assert.deepEqual");
  }, 30000);
  it("holds all cases on catalog/version mismatch without running a worker", async () => {
    const missing = await runQualification({
      root: join(root, "missing"),
      profile: { ...profile, model: "not-in-catalog" },
      endpoint,
      adapter,
      provenance: "fixture",
    });
    expect(missing.cases.every((row) => row.outcome === "held")).toBe(true);
    expect(calls).toBe(0);
    const version = await runQualification({
      root: join(root, "version"),
      profile: { ...profile, harness_version: "9.9.9" },
      endpoint,
      adapter,
      provenance: "fixture",
    });
    expect(version.failures).toContain("harness-version-mismatch");
    expect(calls).toBe(0);
  });
  it("rejects hosted bindings and private roots inside Git or with existing evidence", async () => {
    await expect(
      runQualification({
        root: join(root, "hosted"),
        profile,
        endpoint: { ...endpoint, kind: "open-weight-hosted" },
        adapter,
      }),
    ).rejects.toMatchObject({ code: "qualification_policy" });
    await expect(
      runQualification({ root: process.cwd(), profile, endpoint, adapter }),
    ).rejects.toMatchObject({ code: "qualification_path" });
    await expect(
      runQualification({ root, profile, endpoint, adapter }),
    ).rejects.toMatchObject({ code: "qualification_path" });
    expect(calls).toBe(0);
  });
  it("preserves unknown execution and holds remaining cases instead of rerunning", async () => {
    const result = await runQualification({
      root: join(root, "uncertain"),
      profile,
      endpoint,
      adapter: {
        ...adapter,
        async run() {
          calls++;
          throw new Error("Fixture interruption after start");
        },
      },
      provenance: "fixture",
    });
    expect(result.uncertain).toBe(true);
    expect(calls).toBe(1);
    expect(result.cases[0]?.outcome).toBe("uncertain");
    expect(result.cases.slice(1).every((row) => row.outcome === "held")).toBe(
      true,
    );
    expect(result.qualified).toBe(false);
  });
});

const event = (type: string, part: unknown) => JSON.stringify({ type, part });
describe("tool evidence and metadata qualification boundaries", () => {
  it("rejects echo, compound wrappers and marker text in unused path fields", () => {
    const trace = (
      name: string,
      input: unknown,
      exit = 0,
      output = "spillway-command-ok",
    ) =>
      [
        event("step_start", { id: "start" }),
        event("tool_use", {
          id: "tool",
          tool: name,
          state: { status: "completed", input, output, metadata: { exit } },
        }),
        event("step_finish", { reason: "stop" }),
      ].join("\n");
    for (const command of [
      "echo tools/echo.cjs",
      "true || node tools/echo.cjs",
      "node tools/echo.cjs; true",
      "echo spillway-command-ok # node tools/echo.cjs",
    ])
      expect(
        observeToolEvidence(trace("bash", { command }), "command")
          .requirementsMet,
      ).toBe(false);
    expect(
      observeToolEvidence(
        trace("edit", {
          filePath: "src/unrelated.cjs",
          ignored: "src/value.cjs",
        }),
        "structured-edit",
      ).requirementsMet,
    ).toBe(false);
    expect(
      observeToolEvidence(
        trace("read", {
          filePath: "docs/unrelated.json",
          ignored: "docs/inventory.json",
        }),
        "discovery",
      ).requirementsMet,
    ).toBe(false);
    expect(
      observeToolEvidence(
        trace("bash", { command: "node tools/echo.cjs" }, 0, ""),
        "command",
      ).requirementsMet,
    ).toBe(false);
    const recover = [
      event("step_start", { id: "start" }),
      event("tool_use", {
        id: "fail",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "echo tools/failure.cjs; exit 17" },
          output: "Intentional qualification tool error",
          metadata: { exit: 17 },
        },
      }),
      event("tool_use", {
        id: "recover",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "echo tools/recover.cjs" },
          output: "spillway-recovery-ok",
          metadata: { exit: 0 },
        },
      }),
      event("step_finish", { reason: "stop" }),
    ].join("\n");
    expect(
      observeToolEvidence(recover, "tool-error-recovery").requirementsMet,
    ).toBe(false);
  });
  it("refuses inventory-only multi-round claims without exposed ledger context", () => {
    const trace = [
      event("step_start", { id: "one" }),
      event("tool_use", {
        id: "read",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "docs/inventory.json" },
          output: "inventory only",
        },
      }),
      event("step_start", { id: "two" }),
      event("tool_use", {
        id: "search",
        tool: "grep",
        state: {
          status: "completed",
          input: { pattern: "target-seven", path: "docs/ledger.jsonl" },
          output: "one matching line",
        },
      }),
      event("step_start", { id: "three" }),
      event("tool_use", {
        id: "edit",
        tool: "edit",
        state: { status: "completed", input: { filePath: "src/value.cjs" } },
      }),
      event("tool_use", {
        id: "check",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "node checks/acceptance.cjs" },
          output: "spillway-acceptance-ok",
          metadata: { exit: 0 },
        },
      }),
      event("step_finish", { reason: "stop" }),
    ].join("\n");
    const observed = observeToolEvidence(trace, "multi-round");
    expect(observed.requirementsMet).toBe(false);
    expect(observed.contextBytesObserved).toBe(0);
  });
  it("does not promote final claims, malformed streams, duplicate keys or missing stop", () => {
    for (const text of [
      event("text", { text: "All tools succeeded" }),
      '{"type":"tool_use","type":"text"}',
      "[spillway: output truncated]",
      event("step_start", { id: "start" }),
    ])
      expect(observeToolEvidence(text, "command").requirementsMet).toBe(false);
  });
  it("deduplicates repeated tool IDs and requires actual failure-edit-pass ordering", () => {
    const tool = (id: string, name: string, input: unknown, exit?: number) =>
      event("tool_use", {
        id,
        callID: id,
        tool: name,
        state: {
          status: "completed",
          input,
          output:
            exit === 0
              ? "spillway-acceptance-ok"
              : exit === 1
                ? "AssertionError: fixture failure"
                : "",
          metadata: exit === undefined ? {} : { exit },
        },
      });
    const failure = tool(
      "fail",
      "bash",
      { command: "node checks/acceptance.cjs" },
      1,
    );
    const edit = tool("edit", "edit", { filePath: "src/value.cjs" });
    const pass = tool(
      "pass",
      "bash",
      { command: "node checks/acceptance.cjs" },
      0,
    );
    const start = event("step_start", { id: "start" });
    const stop = event("step_finish", { reason: "stop" });
    expect(
      observeToolEvidence(
        [start, failure, edit, pass, stop].join("\n"),
        "test-driven-repair",
      ).requirementsMet,
    ).toBe(true);
    expect(
      observeToolEvidence(
        [start, pass, edit, failure, stop].join("\n"),
        "test-driven-repair",
      ).requirementsMet,
    ).toBe(false);
    expect(
      observeToolEvidence(
        [start, pass, pass, pass, stop].join("\n"),
        "multi-round",
      ).rounds,
    ).toBe(1);
    expect(
      observeToolEvidence([start, pass, pass, stop].join("\n"), "command")
        .tools,
    ).toHaveLength(1);
  });
  it("allows reviewed model namespace and rejects known secrets, paths, IPs and unknown fields", () => {
    expect(
      qualificationMetadataSchema.parse({
        ...complete,
        model: "qwen/qwen3.8-27b",
      }).model,
    ).toBe("qwen/qwen3.8-27b");
    for (const model of [
      "home/secret",
      "../../private",
      "https://example.com",
      "192.168.0.2",
      ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
      "AIza" + "a".repeat(35),
    ])
      expect(
        qualificationMetadataSchema.safeParse({ ...complete, model }).success,
      ).toBe(false);
    expect(
      qualificationMetadataSchema.safeParse({
        ...complete,
        endpoint: "private",
      }).success,
    ).toBe(false);
    const syntheticAws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    for (const field of ["harnessVersion", "serverVersion", "license"] as const)
      expect(
        qualificationMetadataSchema.safeParse({
          ...complete,
          [field]: field === "license" ? syntheticAws : `1.2.3-${syntheticAws}`,
        }).success,
      ).toBe(false);
    expect(
      qualificationMetadataSchema.safeParse({
        ...complete,
        hardware: { ...complete.hardware, hostname: "private" },
      }).success,
    ).toBe(false);
  });
  it("rejects fixture, unknown-metadata and class-claim community profiles", () => {
    const candidate = {
      version: 1,
      id: "public-example",
      provenance: "real",
      scope: "tool-workload-only",
      qualified: true,
      qualified_classes: [],
      workloadHash: "b".repeat(64),
      metadata: complete,
      cases: CAPABILITIES.map((capability) => ({
        capability,
        outcome: "passed",
        rounds: 3,
        observedTools: ["read", "glob", "grep", "edit", "bash"],
        durationMs: 100,
        contextBytes: 40000,
        contextBytesObserved: 40000,
      })),
    };
    expect(validateCommunityProfile(candidate).qualified).toBe(true);
    for (const patch of [
      { provenance: "fixture" },
      { metadata: { ...complete, modelArtifact: null } },
      { metadata: { ...complete, settings: undefined } },
      { metadata: { ...complete, serverEngine: null } },
      { qualified_classes: ["mechanical"] },
    ])
      expect(() =>
        validateCommunityProfile({ ...candidate, ...patch }),
      ).toThrow();
  });
});
