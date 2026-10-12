import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SpillwayError,
  type EndpointProfile,
  type HarnessAdapter,
  type HarnessInput,
  type HarnessResult,
  type Usage,
} from "./contracts.js";
import { canonicalPath, within, privateDirectory } from "./git.js";
import {
  minimalEnvironment,
  runProcess,
  OUTPUT_TRUNCATED,
  OUTPUT_LIMIT,
} from "./process.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function rejectProjectConfiguration(worktree: string): Promise<void> {
  let path = canonicalPath(worktree);
  for (;;) {
    for (const name of [
      "opencode.json",
      "opencode.jsonc",
      ".opencode",
      ".env",
    ]) {
      if (await exists(join(path, name)))
        throw new SpillwayError(
          "harness_config_conflict",
          "OpenCode project configuration or credential fallback is unsupported in isolated execution",
        );
    }
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
  }
}
async function isolatedEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  await privateDirectory(root);
  const env: NodeJS.ProcessEnv = {
    ...minimalEnvironment(root),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_AUTO_SHARE: "false",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  };
  for (const path of [
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_STATE_HOME,
    env.OPENCODE_CONFIG_DIR,
  ])
    if (path) await privateDirectory(path);
  return env;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly id = "opencode";
  constructor(private readonly executable = "opencode") {}
  async version(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "spillway-version-"));
    try {
      const result = await runProcess({
        command: this.executable,
        args: ["--version"],
        cwd: root,
        env: await isolatedEnvironment(root),
        timeoutMs: 10_000,
      });
      if (result.exitCode !== 0 || result.timedOut)
        throw new SpillwayError(
          "harness_unavailable",
          "OpenCode executable is unavailable",
        );
      const version = result.stdout.trim();
      if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version))
        throw new SpillwayError(
          "harness_version",
          "OpenCode returned an unrecognized version",
        );
      return version;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  async run(input: HarnessInput): Promise<HarnessResult> {
    const artifacts = canonicalPath(dirname(input.logPath));
    if (
      within(artifacts, canonicalPath(input.worktree)) ||
      within(artifacts, canonicalPath(process.cwd()))
    )
      throw new SpillwayError(
        "unsafe_artifacts",
        "Harness artifacts must remain outside repositories",
      );
    await rejectProjectConfiguration(input.worktree);
    const env = await isolatedEnvironment(join(artifacts, "harness-home"));
    const key = input.endpoint.api_key_env
      ? process.env[input.endpoint.api_key_env]
      : undefined;
    if (input.endpoint.api_key_env && !key)
      throw new SpillwayError(
        "missing_credential",
        "Configured endpoint credential is unavailable",
      );
    if (key) env.SPILLWAY_ENDPOINT_KEY = key;
    const model = `spillway/${input.profile.model}`;
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["spillway"],
      model,
      small_model: model,
      share: "disabled",
      autoupdate: false,
      plugin: [],
      mcp: {},
      lsp: false,
      formatter: false,
      permission: {
        "*": "allow",
        webfetch: "deny",
        websearch: "deny",
        external_directory: "deny",
      },
      provider: {
        spillway: {
          npm: "@ai-sdk/openai-compatible",
          name: "Spillway configured endpoint",
          options: {
            baseURL: input.endpoint.url,
            apiKey: key
              ? "{env:SPILLWAY_ENDPOINT_KEY}"
              : "spillway-local-no-key",
          },
          models: { [input.profile.model]: { name: input.profile.model } },
        },
      },
    });
    await writeFile(join(artifacts, "prompt.md"), input.prompt, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(
      join(artifacts, "model.json"),
      JSON.stringify({
        endpoint: input.endpoint.id,
        profile: input.profile.id,
        model: input.profile.model,
        artifact: input.profile.model_artifact,
        harness: this.id,
        version: input.profile.harness_version,
      }),
      { flag: "wx", mode: 0o600 },
    );
    const result = await runProcess({
      command: this.executable,
      args: ["run", "--pure", "--format", "json", "--model", model],
      cwd: input.worktree,
      env,
      stdin: input.prompt,
      timeoutMs: input.timeoutSec * 1000,
      logPath: input.logPath,
      signal: input.signal,
    });
    if (result.timedOut) return { exit: "timeout" };
    if (result.stdout.includes(OUTPUT_TRUNCATED))
      return {
        exit: "transport_error",
        summary: "Harness event output exceeded the bounded parser limit",
      };
    let usage: Usage | undefined;
    let summary: string | undefined;
    let finished = false;
    let errorExit: "failed" | "transport_error" | undefined;
    for (const line of result.stdout
      .split("\n")
      .filter((line) => line.trim())) {
      let event: Record<string, unknown> | undefined;
      try {
        event = object(JSON.parse(line) as unknown);
      } catch {
        return {
          exit: "transport_error",
          summary: "Malformed harness event stream",
        };
      }
      if (!event || typeof event.type !== "string")
        return {
          exit: "transport_error",
          summary: "Malformed harness event stream",
        };
      const part = object(event.part);
      if (event.type === "text" && typeof part?.text === "string")
        summary = part.text.slice(0, 4096);
      if (event.type === "step_finish") {
        // Tool-call rounds also emit step_finish. Require a final stop event.
        finished = part?.reason === "stop";
        const tokens = object(part?.tokens);
        for (const [field, value] of [
          ["inputTokens", tokens?.input],
          ["outputTokens", tokens?.output],
          ["costUsd", part?.cost],
        ] as const) {
          if (nonnegative(value)) {
            usage ??= {};
            usage[field] = (usage[field] ?? 0) + value;
          }
        }
      }
      if (event.type === "error") {
        const error = object(event.error);
        const data = object(error?.data);
        const status = data?.statusCode;
        const message =
          typeof data?.message === "string"
            ? data.message
            : typeof error?.message === "string"
              ? error.message
              : "";
        errorExit =
          (typeof status === "number" && (status === 429 || status >= 500)) ||
          /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|connection refused/i.test(
            message,
          )
            ? "transport_error"
            : "failed";
      }
    }
    if (errorExit) return { exit: errorExit, usage, summary };
    if (result.exitCode !== 0) return { exit: "failed", usage, summary };
    if (!finished)
      return {
        exit: "transport_error",
        summary: "Harness did not emit completion evidence",
      };
    return { exit: "completed", usage, summary };
  }
}

export async function probeEndpoint(
  endpoint: EndpointProfile,
  model: string,
): Promise<{ healthy: boolean; reason?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (endpoint.api_key_env) {
      const key = process.env[endpoint.api_key_env];
      if (!key)
        return {
          healthy: false,
          reason: "Configured endpoint credential is unavailable",
        };
      headers.Authorization = `Bearer ${key}`;
    }
    const response = await fetch(`${endpoint.url.replace(/\/$/, "")}/models`, {
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        healthy: false,
        reason: `Model catalog returned HTTP ${response.status}`,
      };
    }
    const reader = response.body?.getReader();
    if (!reader)
      return { healthy: false, reason: "Model catalog body is missing" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > OUTPUT_LIMIT) {
        await reader.cancel();
        return { healthy: false, reason: "Model catalog exceeds size limit" };
      }
      chunks.push(chunk.value);
    }
    let catalog: Record<string, unknown> | undefined;
    try {
      catalog = object(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      );
    } catch {
      return { healthy: false, reason: "Model catalog is malformed" };
    }
    if (!Array.isArray(catalog?.data))
      return { healthy: false, reason: "Model catalog is malformed" };
    return catalog.data.some((entry) => object(entry)?.id === model)
      ? { healthy: true }
      : { healthy: false, reason: "Configured model is absent from catalog" };
  } catch {
    return {
      healthy: false,
      reason: "Model catalog is unreachable or timed out",
    };
  } finally {
    clearTimeout(timeout);
  }
}
