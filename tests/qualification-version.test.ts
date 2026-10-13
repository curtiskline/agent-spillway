import { it, expect } from "vitest";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runProcess } from "../src/process.js";

it("rejects a mislabeled or unsupported default manifest in an isolated copy of the actual loader", async () => {
  const checkout = fileURLToPath(new URL("..", import.meta.url));
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "spillway-suite-version-")),
  );
  try {
    await chmod(root, 0o700);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "eval", "workload-v2"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await symlink(join(checkout, "node_modules"), join(root, "node_modules"));
    // Copy the actual module/dependencies, rather than adding a public workload
    // override or mutating bundled assets while other tests use them.
    for (const name of [
      "qualification",
      "contracts",
      "git",
      "process",
      "credentials",
      "harness",
      "verify",
      "json",
    ]) {
      const source = await readFile(
        join(checkout, "src", `${name}.ts`),
        "utf8",
      );
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      });
      await writeFile(join(root, "src", `${name}.js`), compiled.outputText);
    }
    for (const name of ["acceptance.cjs", "value.cjs"])
      await copyFile(
        join(checkout, "eval", "workload-v2", name),
        join(root, "eval", "workload-v2", name),
      );
    const original = JSON.parse(
      await readFile(
        join(checkout, "eval", "workload-v2", "workload.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    for (const version of [1, 2, 3]) {
      await writeFile(
        join(root, "eval", "workload-v2", "workload.json"),
        JSON.stringify({ ...original, version }),
      );
      const result = await runProcess({
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `import {qualificationWorkloadHash} from './src/qualification.js';try{await qualificationWorkloadHash();console.log('accepted')}catch(error){if(error.name!=='ZodError')throw error;console.log('rejected')}`,
        ],
        cwd: root,
        timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(
        version === 2 ? "accepted" : "rejected",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
