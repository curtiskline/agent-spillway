import { constants } from "node:fs";
import { lstat, open, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SpillwayError,
  type AttemptRecord,
  type EndpointProfile,
  type HarnessAdapter,
  type ModelProfile,
  type TaskSpec,
  type Usage,
  type VerificationResult,
} from "./contracts.js";
import {
  canonicalPath,
  GitWorkspace,
  gitCommand,
  privateDirectory,
  within,
} from "./git.js";
import { probeEndpoint } from "./harness.js";
import { parseStrictJson } from "./json.js";
import { OUTPUT_TRUNCATED, runProcess } from "./process.js";
import { verifyAttempt } from "./verify.js";

export const CAPABILITIES = [
  "discovery",
  "read-search",
  "structured-edit",
  "command",
  "tool-error-recovery",
  "test-driven-repair",
  "multi-round",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
const knownSecret = (value: string): boolean =>
  /(?:A(?:KI|SI)A[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{8,}|xox[baprs]-|ya29\.[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.test(
    value,
  );
const publicIdentifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z][A-Za-z0-9.+_-]*$/)
  .refine(
    (value) =>
      !knownSecret(value) &&
      !/\b(?:sk|token|secret|password|credential)[_-]/i.test(value) &&
      !/\d+\.\d+\.\d+\.\d+/.test(value) &&
      !/[A-Fa-f0-9]{32,}/.test(value) &&
      !/^(?:https?|ftp|ssh|file|localhost)$/i.test(value) &&
      !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(value),
    "Use a reviewed public identifier, never a credential or network identity",
  );
const modelIdentifier = z
  .string()
  .max(200)
  .refine(
    (value) =>
      value.split("/").length <= 2 &&
      value
        .split("/")
        .every((part) => publicIdentifier.safeParse(part).success) &&
      !/^(?:home|Users|private|var|tmp|etc|Volumes)\//i.test(value),
    "Use one reviewed public vendor/model identifier, never a private path",
  );
const semver = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  )
  .max(100)
  .refine(
    (value) =>
      !knownSecret(value) &&
      !/(?:sk|token|secret|password|credential)[_-]|[a-f0-9]{32,}/i.test(value),
  );
const hardwareSchema = z
  .object({
    cpuCores: z.number().int().positive().max(4096).optional(),
    memoryGiB: z.number().positive().max(65536),
    gpuCount: z.number().int().nonnegative().max(1024).optional(),
    gpuMemoryGiB: z.number().nonnegative().max(65536).optional(),
  })
  .strict();
const settingsSchema = z
  .object({
    quantization: publicIdentifier.nullable(),
    temperature: z.number().min(0).max(2).nullable(),
    seed: z.number().int().nonnegative().nullable(),
    concurrency: z.literal(1),
  })
  .strict();
export const qualificationMetadataSchema = z
  .object({
    model: modelIdentifier.nullable(),
    modelArtifact: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    harnessVersion: semver.nullable(),
    serverVersion: semver.nullable(),
    license: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/)
      .refine((value) => !knownSecret(value))
      .nullable(),
    contextTokens: z.number().int().positive().max(10_000_000).nullable(),
    hardware: hardwareSchema.nullable(),
    serverEngine: z
      .enum(["lm-studio", "llama-cpp", "ollama", "vllm", "sglang"])
      .nullable()
      .optional(),
    settings: settingsSchema.optional(),
  })
  .strict();
export type QualificationMetadata = z.infer<typeof qualificationMetadataSchema>;
const unknownMetadata: QualificationMetadata = {
  model: null,
  modelArtifact: null,
  harnessVersion: null,
  serverVersion: null,
  license: null,
  contextTokens: null,
  hardware: null,
};
export interface ToolObservation {
  tool: string;
  status: "completed" | "error";
  round: number;
  eventIndex: number;
  exitCode: number | null;
}
interface PrivateObservation extends ToolObservation {
  input: Record<string, unknown>;
  output: string;
}
export interface ToolEvidence {
  valid: boolean;
  finalStop: boolean;
  rounds: number;
  tools: ToolObservation[];
  requirementsMet: boolean;
  contextBytesObserved: number;
}
export interface QualificationCaseResult {
  capability: Capability;
  outcome:
    | "passed"
    | "failed"
    | "timeout"
    | "transport_error"
    | "held"
    | "uncertain";
  durationMs: number;
  reason: string | null;
  usage: Usage | null;
  baseSha: string | null;
  resultSha: string | null;
  verification: VerificationResult | null;
  observations: ToolEvidence;
  logPath: string | null;
  worktree: string | null;
  contextBytes: number;
}
export interface QualificationResult {
  version: 1;
  suiteVersion: 1;
  scope: "tool-workload-only";
  provenance: "real" | "fixture";
  qualified: boolean;
  uncertain: boolean;
  startedAt: string;
  finishedAt: string;
  profileId: string;
  catalogModel: string;
  harnessVersion: string | null;
  metadata: QualificationMetadata;
  metadataComplete: boolean;
  requestedSettings: { temperature: 0; concurrency: 1 };
  workloadHash: string;
  failures: string[];
  cases: QualificationCaseResult[];
}
export interface QualificationInput {
  profile: ModelProfile;
  endpoint: EndpointProfile;
  adapter: HarnessAdapter;
  root: string;
  metadata?: unknown;
  signal?: AbortSignal;
  provenance?: "real" | "fixture";
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const toolNames = new Set([
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "apply_patch",
  "bash",
]);
function exactPath(
  value: unknown,
  expected: string,
  worktree?: string,
): boolean {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value.includes("\\") ||
    value.split("/").includes("..")
  )
    return false;
  return (
    (isAbsolute(value)
      ? worktree
        ? relative(worktree, value)
        : null
      : value.replace(/^\.\//, "")) === expected
  );
}
function toolPath(
  tool: PrivateObservation,
  expected: string,
  worktree?: string,
): boolean {
  const paths = [tool.input.filePath, tool.input.path].filter(
    (value) => value !== undefined,
  );
  return paths.length === 1 && exactPath(paths[0], expected, worktree);
}
function scriptCommand(
  tool: PrivateObservation,
  script: string,
  worktree?: string,
): boolean {
  if (tool.tool !== "bash" || tool.input.command !== `node ${script}`)
    return false;
  return (
    tool.input.workdir === undefined ||
    exactPath(tool.input.workdir, ".", worktree) ||
    (worktree !== undefined && tool.input.workdir === worktree)
  );
}
function observedRequirements(
  capability: Capability,
  tools: PrivateObservation[],
  rounds: number,
  worktree?: string,
): boolean {
  const ok = (tool: PrivateObservation) =>
    tool.status === "completed" &&
    (tool.tool !== "bash" || tool.exitCode === 0);
  const read = tools.some(
    (tool) =>
      ok(tool) &&
      tool.tool === "read" &&
      toolPath(tool, "docs/inventory.json", worktree),
  );
  const search = tools.some(
    (tool) =>
      ok(tool) &&
      tool.tool === "grep" &&
      tool.input.pattern === "target-seven" &&
      (exactPath(tool.input.path, "docs/ledger.jsonl", worktree) ||
        exactPath(tool.input.path, "docs", worktree)),
  );
  const edits = tools.filter(
    (tool) =>
      ok(tool) &&
      ["edit", "write", "apply_patch"].includes(tool.tool) &&
      (tool.tool === "apply_patch"
        ? typeof tool.input.patchText === "string" &&
          tool.input.patchText
            .split("\n")
            .filter((line) => line.startsWith("*** ") && / File: /.test(line))
            .every((line) => line === "*** Update File: src/value.cjs") &&
          tool.input.patchText.includes("\n*** Update File: src/value.cjs\n")
        : toolPath(tool, "src/value.cjs", worktree)),
  );
  const check = tools.filter((tool) =>
    scriptCommand(tool, "checks/acceptance.cjs", worktree),
  );
  if (capability === "discovery")
    return (
      read &&
      tools.some(
        (tool) =>
          ok(tool) &&
          tool.tool === "glob" &&
          tool.input.pattern === "docs/**" &&
          (tool.input.path === undefined ||
            exactPath(tool.input.path, ".", worktree)),
      )
    );
  if (capability === "read-search") return read && search;
  if (capability === "structured-edit") return edits.length > 0;
  if (capability === "command")
    return tools.some(
      (tool) =>
        ok(tool) &&
        scriptCommand(tool, "tools/echo.cjs", worktree) &&
        tool.output.includes("spillway-command-ok"),
    );
  if (capability === "tool-error-recovery") {
    const failure = tools.find(
      (tool) =>
        scriptCommand(tool, "tools/failure.cjs", worktree) &&
        tool.output.includes("Intentional qualification tool error") &&
        tool.exitCode === 17,
    );
    return (
      !!failure &&
      tools.some(
        (tool) =>
          tool.eventIndex > failure.eventIndex &&
          ok(tool) &&
          scriptCommand(tool, "tools/recover.cjs", worktree) &&
          tool.output.includes("spillway-recovery-ok"),
      )
    );
  }
  if (capability === "test-driven-repair")
    return check.some(
      (fail) =>
        fail.exitCode !== null &&
        fail.exitCode !== 0 &&
        /AssertionError|ERR_ASSERTION/.test(fail.output) &&
        edits.some(
          (edit) =>
            edit.eventIndex > fail.eventIndex &&
            check.some(
              (pass) =>
                ok(pass) &&
                pass.eventIndex > edit.eventIndex &&
                pass.output.includes("spillway-acceptance-ok"),
            ),
        ),
    );
  return (
    rounds >= 3 &&
    read &&
    search &&
    tools.some(
      (tool) =>
        ok(tool) &&
        tool.tool === "read" &&
        toolPath(tool, "docs/ledger.jsonl", worktree) &&
        tool.output.includes("target-seven") &&
        Buffer.byteLength(tool.output) >= 32000,
    ) &&
    edits.length > 0 &&
    check.some(
      (tool) => ok(tool) && tool.output.includes("spillway-acceptance-ok"),
    ) &&
    new Set(tools.filter(ok).map((tool) => tool.round)).size >= 3
  );
}
export function observeToolEvidence(
  text: string,
  capability: Capability,
  worktree?: string,
): ToolEvidence {
  const tools: PrivateObservation[] = [];
  let rounds = 0;
  let finalStop = false;
  let valid = !text.includes(OUTPUT_TRUNCATED);
  const seenTools = new Set<string>();
  const seenRounds = new Set<string>();
  const lines = text.split("\n").filter((line) => line.trim());
  for (let index = 0; index < lines.length; index++) {
    let event: unknown;
    try {
      event = parseStrictJson(lines[index]!);
    } catch {
      valid = false;
      continue;
    }
    if (!object(event) || typeof event.type !== "string") {
      valid = false;
      continue;
    }
    const part = object(event.part) ? event.part : undefined;
    if (event.type === "step_start") {
      finalStop = false;
      if (typeof part?.id !== "string") {
        valid = false;
        continue;
      }
      if (!seenRounds.has(part.id)) {
        seenRounds.add(part.id);
        rounds++;
      }
    }
    if (event.type === "step_finish") finalStop = part?.reason === "stop";
    if (event.type !== "tool_use") continue;
    const state = object(part?.state) ? part.state : undefined;
    const identity = typeof part?.callID === "string" ? part.callID : part?.id;
    if (
      !part ||
      typeof part.tool !== "string" ||
      !toolNames.has(part.tool) ||
      typeof identity !== "string" ||
      !state ||
      !["completed", "error"].includes(String(state.status))
    ) {
      valid = false;
      continue;
    }
    if (seenTools.has(identity)) continue;
    seenTools.add(identity);
    const metadata = object(state.metadata) ? state.metadata : undefined;
    const structured = object(state.structuredOutput)
      ? state.structuredOutput
      : undefined;
    const exit = metadata?.exit ?? structured?.exit;
    const exitCode =
      typeof exit === "number" && Number.isInteger(exit) ? exit : null;
    if (
      metadata?.truncated === true ||
      metadata?.timeout === true ||
      structured?.truncated === true ||
      structured?.timeout === true
    )
      valid = false;
    tools.push({
      tool: part.tool,
      status: state.status as "completed" | "error",
      round: rounds,
      eventIndex: index,
      exitCode,
      input: object(state.input) ? state.input : {},
      output:
        typeof state.output === "string"
          ? state.output
          : typeof metadata?.output === "string"
            ? metadata.output
            : "",
    });
  }
  return {
    valid,
    finalStop,
    rounds,
    tools: tools.map(({ input: _input, output: _output, ...tool }) => tool),
    contextBytesObserved: tools
      .filter(
        (tool) =>
          tool.status === "completed" &&
          tool.tool === "read" &&
          toolPath(tool, "docs/ledger.jsonl", worktree),
      )
      .reduce((total, tool) => total + Buffer.byteLength(tool.output), 0),
    requirementsMet:
      valid &&
      finalStop &&
      observedRequirements(capability, tools, rounds, worktree),
  };
}
async function privateRead(path: string): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.size > 16 * 1024 * 1024 + 128 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Unsafe qualification transcript");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
const workloadSchema = z
  .object({
    version: z.literal(1),
    license: z.literal("Apache-2.0"),
    timeoutSeconds: z.literal(180),
    contextLines: z.literal(256),
    cases: z
      .array(
        z
          .object({
            id: z.enum(CAPABILITIES),
            expected: z.union([
              z.string(),
              z
                .object({ status: z.literal("ready"), limit: z.literal(3) })
                .strict(),
            ]),
            instruction: z.string().min(1),
          })
          .strict(),
      )
      .length(7),
  })
  .strict();
const TOOL_FILES = {
  "echo.cjs": "console.log('spillway-command-ok');\n",
  "failure.cjs":
    "console.error('Intentional qualification tool error'); process.exit(17);\n",
  "recover.cjs": "console.log('spillway-recovery-ok');\n",
};
async function workload() {
  const raw = await readFile(
    new URL("../eval/workload-v1/workload.json", import.meta.url),
    "utf8",
  );
  const manifest = workloadSchema.parse(parseStrictJson(raw));
  if (
    new Set(manifest.cases.map((item) => item.id)).size !== CAPABILITIES.length
  )
    throw new Error("Workload capabilities are incomplete");
  const source = await readFile(
    new URL("../eval/workload-v1/value.cjs", import.meta.url),
    "utf8",
  );
  const check = await readFile(
    new URL("../eval/workload-v1/acceptance.cjs", import.meta.url),
    "utf8",
  );
  const hash = createHash("sha256")
    .update(raw)
    .update(source)
    .update(check)
    .update(JSON.stringify(TOOL_FILES))
    .digest("hex");
  return { manifest, source, check, hash };
}
export async function qualificationWorkloadHash(): Promise<string> {
  return (await workload()).hash;
}
async function emptyPrivateRoot(path: string): Promise<string> {
  if (
    !isAbsolute(path) ||
    canonicalPath(path) !== resolve(path) ||
    within(path, canonicalPath(process.cwd()))
  )
    throw new SpillwayError(
      "qualification_path",
      "Qualification requires a canonical private root outside repositories.",
    );
  let ancestor = path;
  while (true) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) throw new Error("Symlink");
      if (info.isDirectory()) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new SpillwayError(
          "qualification_path",
          "Qualification root is unsafe.",
        );
    }
    ancestor = dirname(ancestor);
  }
  try {
    await gitCommand(ancestor, ["rev-parse", "--show-toplevel"]);
    throw new SpillwayError(
      "qualification_path",
      "Qualification root must be outside Git repositories.",
    );
  } catch (error) {
    if (!(error instanceof SpillwayError) || error.code !== "git_error")
      throw error;
  }
  await privateDirectory(path);
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (await readdir(path)).length !== 0
  )
    throw new SpillwayError(
      "qualification_path",
      "Qualification root must be a new empty owner directory.",
    );
  return path;
}
function metadataComplete(metadata: QualificationMetadata): boolean {
  return [
    metadata.model,
    metadata.modelArtifact,
    metadata.harnessVersion,
    metadata.serverVersion,
    metadata.license,
    metadata.contextTokens,
    metadata.hardware,
    metadata.serverEngine,
    metadata.settings?.quantization,
    metadata.settings?.temperature,
  ].every((value) => value !== null && value !== undefined);
}

export async function runQualification(
  input: QualificationInput,
): Promise<QualificationResult> {
  if (input.endpoint.kind !== "local")
    throw new SpillwayError(
      "qualification_policy",
      "Qualification is limited to explicitly local endpoints.",
    );
  const address = new URL(input.endpoint.url);
  if (
    !["http:", "https:"].includes(address.protocol) ||
    address.username ||
    address.password ||
    address.search ||
    address.hash ||
    !/\/v1\/?$/.test(address.pathname)
  )
    throw new SpillwayError(
      "qualification_policy",
      "Qualification endpoint must be a configured OpenAI-compatible base.",
    );
  if (
    input.profile.endpoint !== input.endpoint.id ||
    input.profile.harness !== "opencode" ||
    input.adapter.id !== "opencode"
  )
    throw new SpillwayError(
      "qualification_binding",
      "Qualification requires the exact configured OpenCode binding.",
    );
  const metadata = qualificationMetadataSchema.parse(
    input.metadata ?? unknownMetadata,
  );
  const assets = await workload();
  const root = await emptyPrivateRoot(input.root);
  const result: QualificationResult = {
    version: 1,
    suiteVersion: 1,
    scope: "tool-workload-only",
    provenance: input.provenance ?? "real",
    qualified: false,
    uncertain: false,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    profileId: input.profile.id,
    catalogModel: input.profile.model,
    harnessVersion: null,
    metadata,
    metadataComplete: metadataComplete(metadata),
    requestedSettings: { temperature: 0, concurrency: 1 },
    workloadHash: assets.hash,
    failures: [],
    cases: [],
  };
  let preflight: string | null = input.signal?.aborted ? "cancelled" : null;
  if (!preflight) {
    try {
      result.harnessVersion = await input.adapter.version();
      if (result.harnessVersion !== input.profile.harness_version)
        preflight = "harness-version-mismatch";
    } catch {
      preflight = "harness-unavailable";
    }
  }
  if (
    !preflight &&
    !(await probeEndpoint(input.endpoint, input.profile.model)).healthy
  )
    preflight = "catalog-unavailable-or-model-mismatch";
  if (preflight) result.failures.push(preflight);
  const inventory = Object.fromEntries(
    assets.manifest.cases
      .filter((item) => item.id !== "multi-round")
      .map((item) => [item.id, item.expected]),
  );
  const ledger =
    Array.from({ length: assets.manifest.contextLines }, (_, index) =>
      JSON.stringify({
        index,
        label: index === 173 ? "target-seven" : `record-${index}`,
        note: "Public qualification context: inspect the target record and preserve every protected fixture.",
        value:
          index === 173
            ? assets.manifest.cases.find((item) => item.id === "multi-round")!
                .expected
            : "unrelated",
      }),
    ).join("\n") + "\n";
  for (let index = 0; index < assets.manifest.cases.length; index++) {
    const scenario = assets.manifest.cases[index]!;
    const row: QualificationCaseResult = {
      capability: scenario.id,
      outcome: "held",
      durationMs: 0,
      reason: preflight,
      usage: null,
      baseSha: null,
      resultSha: null,
      verification: null,
      observations: {
        valid: false,
        finalStop: false,
        rounds: 0,
        tools: [],
        requirementsMet: false,
        contextBytesObserved: 0,
      },
      logPath: null,
      worktree: null,
      contextBytes: Buffer.byteLength(ledger),
    };
    result.cases.push(row);
    if (preflight || result.uncertain || input.signal?.aborted) {
      row.reason ??= result.uncertain
        ? "prior-execution-uncertain"
        : "cancelled";
      continue;
    }
    const started = Date.now();
    let workerStarted = false;
    try {
      const repo = join(root, "cases", scenario.id, "repo");
      const runtime = join(root, "runtime", scenario.id);
      const artifacts = join(root, "artifacts", scenario.id);
      for (const directory of [
        repo,
        runtime,
        artifacts,
        ...["src", "checks", "fixtures", "docs", "tools"].map((name) =>
          join(repo, name),
        ),
      ])
        await privateDirectory(directory);
      await writeFile(join(repo, "src/value.cjs"), assets.source);
      await writeFile(join(repo, "checks/acceptance.cjs"), assets.check);
      await writeFile(
        join(repo, "fixtures/expected.json"),
        JSON.stringify(
          scenario.id === "multi-round"
            ? {
                sha256: createHash("sha256")
                  .update(JSON.stringify(scenario.expected))
                  .digest("hex"),
              }
            : { value: scenario.expected },
        ),
      );
      await writeFile(
        join(repo, "docs/inventory.json"),
        JSON.stringify(inventory, null, 2),
      );
      await writeFile(join(repo, "docs/ledger.jsonl"), ledger);
      for (const [name, source] of Object.entries(TOOL_FILES))
        await writeFile(
          join(repo, "tools", name),
          "// SPDX-License-Identifier: Apache-2.0\n" + source,
        );
      for (const args of [
        ["init", "-b", "main"],
        ["config", "user.name", "Spillway Qualification"],
        ["config", "user.email", "qualification@example.invalid"],
        ["add", "."],
        ["commit", "-m", "Apache qualification baseline"],
      ])
        await gitCommand(repo, args);
      const baseline = await runProcess({
        command: process.execPath,
        args: ["checks/acceptance.cjs"],
        cwd: repo,
        timeoutMs: 5000,
        logPath: join(artifacts, "baseline-check.log"),
      });
      if (baseline.exitCode !== 1)
        throw new Error("Acceptance fixture must fail on baseline");
      const workspace = new GitWorkspace(repo, runtime);
      const baseSha = await workspace.resolveBase("main");
      row.baseSha = baseSha;
      const id = `qual-${scenario.id}`;
      const worktree = await workspace.createWorker(id, baseSha, index + 1);
      row.worktree = worktree;
      const logPath = join(artifacts, "worker.log");
      row.logPath = logPath;
      const spec: TaskSpec = {
        id,
        repo,
        base: "main",
        class: "mechanical",
        after: [],
        scope: ["src/value.cjs"],
        protected: ["checks/**", "fixtures/**", "docs/**", "tools/**"],
        context: ["docs/inventory.json", "docs/ledger.jsonl"],
        checks: ["node checks/acceptance.cjs"],
        review: "checks-only",
        limits: { max_minutes: 3, max_attempts: 1 },
        body: scenario.instruction,
      };
      const prompt = `Apache-2.0 fixed qualification workload v1, case ${scenario.id}. ${scenario.instruction}\nReturn the expected value from the exported function in src/value.cjs. Only src/value.cjs may change. Checks/docs/fixtures/tools are protected. Use exact direct commands: node tools/echo.cjs, node tools/failure.cjs, node tools/recover.cjs, node checks/acceptance.cjs as requested; no compound wrappers, aliases or echo substitutes. Use the read tool with docs/inventory.json and (for multi-round) the full docs/ledger.jsonl; grep target-seven in docs/ledger.jsonl. The multi-round value is only in the ledger. Use the edit/write filePath for src/value.cjs. Run node checks/acceptance.cjs, commit your change on spillway/${id}, and leave the worktree clean. Do not push, merge, deploy, install dependencies or contact any other provider. Use existing harness tools; final claims do not substitute for observed tool evidence.\n`;
      const attempt: AttemptRecord = {
        id: index + 1,
        taskId: id,
        endpoint: input.endpoint.id,
        profileId: input.profile.id,
        model: input.profile.model,
        modelArtifact: input.profile.model_artifact,
        harness: input.adapter.id,
        harnessVersion: result.harnessVersion!,
        baseSha,
        branch: `spillway/${id}`,
        worktree,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: "running",
        usage: null,
        summary: null,
        logPath,
        resultSha: null,
        verification: null,
        reportPath: null,
      };
      workerStarted = true;
      const execution = await input.adapter.run({
        worktree,
        prompt,
        endpoint: input.endpoint,
        profile: input.profile,
        timeoutSec: assets.manifest.timeoutSeconds,
        logPath,
        purpose: "worker",
        temperature: 0,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      workerStarted = false;
      row.usage = execution.usage ?? null;
      try {
        row.observations = observeToolEvidence(
          await privateRead(logPath),
          scenario.id,
          worktree,
        );
      } catch {
        row.reason = "tool-evidence-unavailable";
      }
      if (execution.exit !== "completed") {
        row.outcome = execution.exit === "failed" ? "failed" : execution.exit;
        row.reason ??= `harness-${execution.exit}`;
      } else {
        const verification = await verifyAttempt({
          spec,
          attempt,
          workspace,
          artifactDir: join(artifacts, "verification"),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        row.verification = verification;
        row.resultSha = verification.resultSha ?? null;
        row.outcome =
          verification.passed &&
          row.observations.requirementsMet &&
          verification.flags.length === 0
            ? "passed"
            : "failed";
        if (row.outcome !== "passed")
          row.reason ??= !verification.passed
            ? "independent-verification-failed"
            : verification.flags.length
              ? "verification-policy-flags"
              : "required-tool-evidence-missing";
      }
    } catch {
      row.outcome = workerStarted ? "uncertain" : "failed";
      row.reason = workerStarted
        ? "execution-state-uncertain"
        : "qualification-case-failed";
      if (workerStarted) result.uncertain = true;
    } finally {
      row.durationMs = Date.now() - started;
    }
  }
  if (!result.metadataComplete) result.failures.push("metadata-incomplete");
  if (metadata.settings?.temperature !== 0)
    result.failures.push("metadata-settings-mismatch");
  if (
    metadata.model !== input.profile.model ||
    metadata.harnessVersion !== result.harnessVersion ||
    metadata.modelArtifact !==
      input.profile.model_artifact.replace(/^sha256:/, "")
  )
    result.failures.push("metadata-binding-unverified");
  if (result.provenance === "fixture")
    result.failures.push("fixture-provenance");
  for (const row of result.cases)
    if (row.outcome !== "passed")
      result.failures.push(`${row.capability}:${row.outcome}`);
  result.qualified = result.failures.length === 0 && !result.uncertain;
  result.finishedAt = new Date().toISOString();
  await writeFile(
    join(root, "qualification.json"),
    JSON.stringify(result, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return result;
}

const completeMetadataSchema = qualificationMetadataSchema.refine(
  (metadata) =>
    metadataComplete(metadata) && metadata.settings?.temperature === 0,
  "Real qualified profiles require complete reproducible metadata",
);
const publicCaseSchema = z
  .object({
    capability: z.enum(CAPABILITIES),
    outcome: z.literal("passed"),
    rounds: z.number().int().positive(),
    observedTools: z
      .array(
        z.enum([
          "read",
          "glob",
          "grep",
          "edit",
          "write",
          "apply_patch",
          "bash",
        ]),
      )
      .min(1),
    durationMs: z.number().nonnegative(),
    contextBytes: z.number().int().positive(),
    contextBytesObserved: z.number().int().nonnegative(),
  })
  .strict()
  .refine((row) => {
    const tools = new Set(row.observedTools);
    const edit = ["edit", "write", "apply_patch"].some((tool) =>
      tools.has(tool as "edit" | "write" | "apply_patch"),
    );
    if (row.capability === "discovery")
      return tools.has("read") && tools.has("glob");
    if (row.capability === "read-search")
      return tools.has("read") && tools.has("grep");
    if (row.capability === "structured-edit") return edit;
    if (
      row.capability === "command" ||
      row.capability === "tool-error-recovery"
    )
      return tools.has("bash");
    if (row.capability === "test-driven-repair")
      return edit && tools.has("bash");
    return (
      row.rounds >= 3 &&
      row.contextBytesObserved >= 32000 &&
      tools.has("read") &&
      tools.has("grep") &&
      edit &&
      tools.has("bash")
    );
  }, "Public observations must support the fixed capability");
const communitySchema = z
  .object({
    version: z.literal(1),
    id: publicIdentifier,
    provenance: z.literal("real"),
    scope: z.literal("tool-workload-only"),
    qualified: z.literal(true),
    qualified_classes: z.array(z.never()).length(0),
    workloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    metadata: completeMetadataSchema,
    cases: z.array(publicCaseSchema).length(7),
  })
  .strict()
  .refine(
    (profile) =>
      new Set(profile.cases.map((row) => row.capability)).size ===
      CAPABILITIES.length,
    "All seven distinct capabilities are required",
  );
export function validateCommunityProfile(
  value: unknown,
): z.infer<typeof communitySchema> {
  return communitySchema.parse(value);
}
/** Explicit reviewed projection only: never writes or publishes a community profile. */
export function communityProjection(
  result: QualificationResult,
  id: string,
): z.infer<typeof communitySchema> {
  if (
    !result.qualified ||
    result.provenance !== "real" ||
    result.uncertain ||
    result.metadata.model !== result.catalogModel ||
    result.metadata.harnessVersion !== result.harnessVersion ||
    result.cases.some(
      (row) => !row.observations.requirementsMet || !row.verification?.passed,
    )
  )
    throw new SpillwayError(
      "unqualified_profile",
      "Only complete real observed workload results may be projected.",
    );
  return validateCommunityProfile({
    version: 1,
    id,
    provenance: "real",
    scope: "tool-workload-only",
    qualified: true,
    qualified_classes: [],
    workloadHash: result.workloadHash,
    metadata: result.metadata,
    cases: result.cases.map((row) => ({
      capability: row.capability,
      outcome: row.outcome,
      rounds: row.observations.rounds,
      observedTools: [
        ...new Set(row.observations.tools.map((tool) => tool.tool)),
      ],
      durationMs: row.durationMs,
      contextBytes: row.contextBytes,
      contextBytesObserved: row.observations.contextBytesObserved,
    })),
  });
}
