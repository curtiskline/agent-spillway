import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ProcessInput, ProcessResult } from "./contracts.js";

export const OUTPUT_LIMIT = 1024 * 1024;
const LOG_LIMIT = 16 * OUTPUT_LIMIT;
export const OUTPUT_TRUNCATED = "\n[spillway: output truncated]\n";

/** Explicit allowlist: provider keys, Git overrides and startup hooks never inherit. */
export function minimalEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
}

function secrets(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set(
      Object.entries({ ...process.env, ...env })
        .filter(
          ([name, value]) =>
            /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
            typeof value === "string" &&
            value.length > 0,
        )
        .map(([, value]) => value as string),
    ),
  ].sort((a, b) => b.length - a.length);
}

export async function runProcess(input: ProcessInput): Promise<ProcessResult> {
  const started = Date.now();
  if (
    !Number.isFinite(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.signal?.aborted
  ) {
    const stderr = "Execution cancelled or deadline exhausted";
    if (input.logPath) {
      await mkdir(dirname(input.logPath), { recursive: true, mode: 0o700 });
      const log = await open(input.logPath, "wx", 0o600);
      try {
        await log.write(stderr);
      } finally {
        await log.close();
      }
    }
    return {
      exitCode: null,
      timedOut: true,
      stdout: "",
      stderr,
      durationMs: 0,
    };
  }
  const env = input.env ?? minimalEnvironment(input.cwd);
  const privateValues = secrets(env);
  const redact = (text: string) =>
    privateValues.reduce(
      (result, secret) => result.split(secret).join("[REDACTED]"),
      text,
    );
  // Redact across arbitrary pipe chunk boundaries before persisting anything.
  const tailSize = Math.max(
    0,
    ...privateValues.map((value) => value.length - 1),
  );
  if (input.logPath)
    await mkdir(dirname(input.logPath), { recursive: true, mode: 0o700 });
  const log = input.logPath
    ? await open(input.logPath, "wx", 0o600)
    : undefined;
  let logBytes = 0;
  let writeError: Error | undefined;
  let writes = Promise.resolve();
  const outputs = { stdout: "", stderr: "" };
  const sizes = { stdout: 0, stderr: 0 };
  const truncated = { stdout: false, stderr: false };
  const decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  const tails = { stdout: "", stderr: "" };
  const emit = (stream: "stdout" | "stderr", text: string) => {
    const safe = redact(text);
    if (!truncated[stream]) {
      const room = OUTPUT_LIMIT - sizes[stream];
      const data = Buffer.from(safe);
      outputs[stream] += data.subarray(0, room).toString("utf8");
      sizes[stream] += Math.min(room, data.length);
      if (data.length > room) {
        outputs[stream] += OUTPUT_TRUNCATED;
        truncated[stream] = true;
      }
    }
    if (log && logBytes < LOG_LIMIT) {
      const data = Buffer.from(safe).subarray(0, LOG_LIMIT - logBytes);
      logBytes += data.length;
      writes = writes
        .then(async () => {
          await log.write(data);
        })
        .catch((error: unknown) => {
          writeError =
            error instanceof Error ? error : new Error("Log write failed");
        });
      if (logBytes === LOG_LIMIT)
        writes = writes
          .then(async () => {
            await log.write(OUTPUT_TRUNCATED);
          })
          .catch((error: unknown) => {
            writeError =
              error instanceof Error ? error : new Error("Log write failed");
          });
    }
  };
  const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
    const text = tails[stream] + decoders[stream].write(chunk);
    // Keep a tail beginning before any possible secret crossing the boundary.
    let cut = Math.max(0, text.length - tailSize);
    for (const secret of privateValues) {
      let index = text.indexOf(secret);
      while (index >= 0) {
        if (index < cut && index + secret.length > cut) cut = index;
        index = text.indexOf(secret, index + secret.length);
      }
    }
    emit(stream, text.slice(0, cut));
    tails[stream] = text.slice(cut);
  };
  try {
    return await new Promise<ProcessResult>((resolve) => {
      const child = spawn(input.command, input.args ?? [], {
        cwd: input.cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let timedOut = false;
      let finished = false;
      let launchFailed = false;
      let escalation: NodeJS.Timeout | undefined;
      const killGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch {
          /* group already exited */
        }
      };
      const stop = () => {
        if (timedOut || finished) return;
        timedOut = true;
        killGroup("SIGTERM");
        escalation = setTimeout(() => killGroup("SIGKILL"), 250);
      };
      const timer = setTimeout(stop, Math.min(input.timeoutMs, 2_147_483_647));
      input.signal?.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));
      child.stdin.on("error", () => {
        /* early exit / EPIPE is reported by child status */
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        launchFailed = true;
        emit("stderr", `Unable to launch process (${error.code ?? "unknown"})`);
      });
      child.on("close", async (exitCode) => {
        finished = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", stop);
        // Even a successful parent must not leave background descendants running.
        killGroup("SIGKILL");
        if (escalation) clearTimeout(escalation);
        for (const stream of ["stdout", "stderr"] as const)
          emit(stream, tails[stream] + decoders[stream].end());
        await writes;
        if (writeError) {
          emit("stderr", "\nPrivate log write failed");
          exitCode = null;
        }
        resolve({
          exitCode: launchFailed ? null : exitCode,
          timedOut,
          ...outputs,
          durationMs: Date.now() - started,
        });
      });
      child.stdin.end(input.stdin);
      if (input.signal?.aborted) stop();
    });
  } finally {
    await writes;
    await log?.close();
  }
}
