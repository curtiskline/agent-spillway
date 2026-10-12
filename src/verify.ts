import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";
import type { VerifyInput, VerificationResult } from "./contracts.js";
import { canonicalPath, gitCommand, privateDirectory, within } from "./git.js";
import { minimalEnvironment, runProcess, OUTPUT_LIMIT } from "./process.js";

interface Change {
  status: string;
  paths: string[];
}
function parseChanges(output: string): Change[] {
  const fields = output.split("\0");
  const changes: Change[] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++]!;
    const path = fields[index++];
    if (!/^[AMDRCTUXB][0-9]*$/.test(status) || !path)
      throw new Error("Malformed Git change record");
    const paths = [path];
    if (/^[RC]/.test(status)) {
      const next = fields[index++];
      if (!next) throw new Error("Malformed Git rename record");
      paths.push(next);
    }
    changes.push({ status, paths });
  }
  return changes;
}
function flagsFor(changes: Change[], diff: string): string[] {
  const flags = new Set<string>();
  const sensitive =
    /(?:^|\/)(?:package\.json|(?:package-lock|npm-shrinkwrap)\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|requirements[^/]*|pyproject\.toml|poetry\.lock|Dockerfile)(?:\/|$)|^\.(?:github|gitlab)\/|\.gitlab-ci\.yml$/i;
  const securityName =
    /(?:^|[/._-])(?:auth|authentication|authorization|authenticate|authorize|authn|authz|security|permissions?|secrets?|migrations?)(?=[/._-]|$)/i;
  const testPath =
    /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i;
  for (const change of changes) {
    // Treat filename tokens and camelCase names like directory segments too.
    if (
      change.paths.some(
        (path) =>
          sensitive.test(path) ||
          securityName.test(path.replace(/([a-z0-9])([A-Z])/g, "$1-$2")),
      )
    )
      flags.add("security-sensitive-path");
    if (
      change.status.startsWith("D") &&
      change.paths.some((path) => testPath.test(path))
    )
      flags.add("deleted-tests");
  }
  const removed = diff
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => line.slice(1));
  const added = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  if (
    added.some((line) =>
      /\b(?:it|test|describe)\.(?:skip|todo)|\b(?:xit|xtest|xdescribe)\s*\(|@(?:pytest\.)?mark\.skip|\b(?:skip|Ignore)\s*\(/.test(
        line,
      ),
    )
  )
    flags.add("skipped-tests");
  const assertions = (lines: string[]) =>
    lines.reduce(
      (count, line) =>
        count +
        (line.match(/\b(?:expect|assert(?:[A-Z_a-z][\w]*)?)\s*(?:\(|\.)/g)
          ?.length ?? 0),
      0,
    );
  if (assertions(removed) > assertions(added)) flags.add("reduced-assertions");
  const tests = (lines: string[]) =>
    lines.reduce(
      (count, line) =>
        count +
        (line.match(/\b(?:it|test|describe)\s*\(|\bdef\s+test_/g)?.length ?? 0),
      0,
    );
  if (tests(removed) > tests(added)) flags.add("removed-tests");
  return [...flags];
}

async function captureDirty(
  input: VerifyInput,
  dirtyPaths: string[],
  diffPath: string,
): Promise<void> {
  let evidence = await gitCommand(input.attempt.worktree, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    input.attempt.baseSha,
    "--",
  ]);
  evidence += "\nWorker residue (including untracked / ignored):\n";
  for (const path of dirtyPaths) {
    evidence += `${JSON.stringify(path)}\n`;
    const full = join(input.attempt.worktree, path);
    if (!within(canonicalPath(full), canonicalPath(input.attempt.worktree)))
      continue;
    try {
      const stat = await lstat(full);
      if (
        stat.isFile() &&
        stat.size <= 65536 &&
        evidence.length < OUTPUT_LIMIT
      ) {
        const content = await readFile(full);
        if (!content.includes(0)) evidence += content.toString("utf8") + "\n";
      }
    } catch {
      /* deleted path or concurrent worker mutation is already a failure */
    }
    if (evidence.length > OUTPUT_LIMIT) {
      evidence = evidence.slice(0, OUTPUT_LIMIT) + "\n[Evidence truncated]\n";
      break;
    }
  }
  await writeFile(diffPath, evidence, { flag: "wx", mode: 0o600 });
}

export async function verifyAttempt(
  input: VerifyInput,
): Promise<VerificationResult> {
  const { attempt, workspace, spec } = input;
  const result: VerificationResult = {
    passed: false,
    changedPaths: [],
    flags: [],
    checks: [],
  };
  let checkout: string | undefined;
  try {
    const artifacts = canonicalPath(input.artifactDir);
    if (
      within(artifacts, canonicalPath(spec.repo)) ||
      within(artifacts, canonicalPath(attempt.worktree)) ||
      within(artifacts, canonicalPath(process.cwd()))
    )
      throw new Error("Verification artifacts must be outside repositories");
    await privateDirectory(artifacts);
    if (
      [...spec.scope, ...spec.protected].some((pattern) =>
        pattern.startsWith("!"),
      )
    ) {
      result.reason = "Negated scope/protected patterns are unsupported";
      return result;
    }
    const inspection = await workspace.inspect(
      attempt.worktree,
      attempt.baseSha,
      attempt.branch,
    );
    result.resultSha = inspection.head;
    result.diffPath = join(artifacts, "diff.patch");
    if (!inspection.clean) {
      await captureDirty(input, inspection.dirtyPaths, result.diffPath);
      result.reason =
        "Worker checkout contains uncommitted, untracked or ignored changes";
      return result;
    }
    await writeFile(
      result.diffPath,
      await workspace.diff(attempt.baseSha, inspection.head),
      { flag: "wx", mode: 0o600 },
    );
    if (
      inspection.branch !== attempt.branch ||
      attempt.branch !== `spillway/${spec.id}`
    ) {
      result.reason = "Result is not on the exact task branch";
      return result;
    }
    if (
      !inspection.descendant ||
      !(await workspace.isAncestor(attempt.baseSha, inspection.head))
    ) {
      result.reason = "Result commit does not descend from the recorded base";
      return result;
    }
    if (!inspection.hasChanges || inspection.head === attempt.baseSha) {
      result.reason = "Worker did not create a new commit with changes";
      return result;
    }
    const ref = (
      await gitCommand(attempt.worktree, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `refs/heads/${attempt.branch}^{commit}`,
      ])
    ).trim();
    if (ref !== inspection.head) {
      result.reason = "Result branch changed during inspection";
      return result;
    }
    const changes = parseChanges(
      await gitCommand(attempt.worktree, [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        attempt.baseSha,
        inspection.head,
        "--",
      ]),
    );
    result.changedPaths = [
      ...new Set(changes.flatMap((change) => change.paths)),
    ];
    // Git permits newlines in filenames; glob wildcards must match them too.
    const inScope = picomatch(spec.scope, { dot: true, flags: "s" });
    const protectedPath =
      spec.protected.length > 0
        ? picomatch(spec.protected, { dot: true, flags: "s" })
        : () => false;
    if (result.changedPaths.some((path) => !inScope(path))) {
      result.reason = "Result changes paths outside task scope";
      return result;
    }
    if (result.changedPaths.some((path) => protectedPath(path))) {
      result.reason = "Result changes protected paths";
      return result;
    }
    const tree = await gitCommand(attempt.worktree, [
      "ls-tree",
      "-r",
      "-z",
      inspection.head,
      "--",
    ]);
    const symlinks = tree
      .split("\0")
      .filter((entry) => entry.startsWith("120000 "))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1));
    if (result.changedPaths.some((path) => symlinks.includes(path))) {
      result.reason = "Result introduces or changes symbolic links";
      return result;
    }
    result.flags = flagsFor(changes, await readFile(result.diffPath, "utf8"));
    checkout = await workspace.createVerification(inspection.head, attempt.id);
    const deadline =
      Date.parse(attempt.startedAt) + spec.limits.max_minutes * 60_000;
    if (!Number.isFinite(deadline))
      throw new Error("Attempt start time is invalid");
    const checkHome = join(artifacts, "check-home");
    await privateDirectory(checkHome);
    const initialHead = (
      await gitCommand(checkout, ["rev-parse", "--verify", "HEAD"])
    ).trim();
    const initialStatus = await gitCommand(checkout, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]);
    if (initialHead !== inspection.head || initialStatus) {
      result.reason = "Verification checkout is not pristine";
      return result;
    }
    for (let index = 0; index < spec.checks.length; index++) {
      const command = spec.checks[index]!;
      const logPath = join(artifacts, `check-${index + 1}.log`);
      const check = await runProcess({
        command: "/bin/sh",
        args: ["-c", command],
        cwd: checkout,
        env: {
          ...minimalEnvironment(checkHome),
          XDG_CONFIG_HOME: join(checkHome, "config"),
          XDG_DATA_HOME: join(checkHome, "data"),
          XDG_CACHE_HOME: join(checkHome, "cache"),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        timeoutMs: deadline - Date.now(),
        signal: input.signal,
        logPath,
      });
      result.checks.push({
        command,
        logPath,
        exitCode: check.exitCode,
        timedOut: check.timedOut,
        durationMs: check.durationMs,
      });
      if (check.exitCode !== 0 || check.timedOut) {
        result.reason = check.timedOut
          ? "Verification time budget exhausted or cancelled"
          : "Verification check failed";
        return result;
      }
      if (
        (
          await gitCommand(checkout, ["rev-parse", "--verify", "HEAD"])
        ).trim() !== inspection.head ||
        (await gitCommand(checkout, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=no",
        ]))
      ) {
        result.reason = "Verification checks mutated tracked files or commit";
        return result;
      }
      const current = await workspace.inspect(
        attempt.worktree,
        attempt.baseSha,
        attempt.branch,
      );
      if (
        !current.clean ||
        current.head !== inspection.head ||
        current.branch !== attempt.branch ||
        (
          await gitCommand(checkout, [
            "rev-parse",
            "--verify",
            `refs/heads/${attempt.branch}`,
          ])
        ).trim() !== inspection.head
      ) {
        result.reason = "Result branch or worker changed during verification";
        return result;
      }
    }
    const final = await workspace.inspect(
      attempt.worktree,
      attempt.baseSha,
      attempt.branch,
    );
    if (
      !final.clean ||
      final.head !== inspection.head ||
      final.branch !== attempt.branch ||
      (
        await gitCommand(checkout, [
          "rev-parse",
          "--verify",
          `refs/heads/${attempt.branch}`,
        ])
      ).trim() !== inspection.head
    ) {
      result.reason = "Result branch or worker changed during verification";
      return result;
    }
    if (input.signal?.aborted || Date.now() >= deadline) {
      result.reason = "Verification time budget exhausted or cancelled";
      return result;
    }
    result.passed = true;
    return result;
  } catch (error: unknown) {
    result.reason =
      error instanceof Error ? error.message : "Verification failed";
    return result;
  } finally {
    if (checkout) {
      try {
        await workspace.removeVerification(checkout);
      } catch {
        result.passed = false;
        result.reason = "Verification checkout cleanup failed";
      }
    }
  }
}
