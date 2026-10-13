import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
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
  qualificationWorkloadHash,
  runQualification,
  validateCommunityProfile,
  type QualificationMetadata,
} from "../src/qualification.js";
import { runProcess } from "../src/process.js";
import { Controller } from "../src/controller.js";
import { Store } from "../src/store.js";
import type {
  EndpointProfile,
  HarnessAdapter,
  ModelProfile,
} from "../src/contracts.js";

const LEGACY_WORKLOAD_HASH =
  "782895eff32247f36c8c50782186582f2ebf075854879d1c1687ba476869b9f8";
const V2_WORKLOAD_HASH =
  "efb69d418862097a76f625212bf14e87575e91a5b19149c418f012d7d1452b5e";

describe("immutable qualification workload revisions", () => {
  it("preserves every v1 byte and changes only the v2 manifest revision and discovery instruction", async () => {
    const digests = {
      "README.md":
        "0ec630b14c6900660c0ffd718cf659b3347db5af3559fac04e8e6d8c87867beb",
      "acceptance.cjs":
        "b8306d5b7c31b55fcd5c7567a60de455e2fcafa8d7b3784a19171571a77991ab",
      "value.cjs":
        "688506beebc9c05e799857154be43808c81907ff34f05627d8f608d9ab77c4a5",
      "workload.json":
        "2d1ebac27fdf5fb6cf5ee21f378960f54cb705886698bd3c6f42e65515d69114",
    };
    for (const [name, expected] of Object.entries(digests)) {
      const original = await readFile(
        new URL(`../eval/workload-v1/${name}`, import.meta.url),
      );
      expect(createHash("sha256").update(original).digest("hex")).toBe(
        expected,
      );
      if (name === "acceptance.cjs" || name === "value.cjs")
        expect(
          await readFile(
            new URL(`../eval/workload-v2/${name}`, import.meta.url),
          ),
        ).toEqual(original);
    }
    interface Manifest {
      version: number;
      cases: Array<{ id: string; instruction: string; expected: unknown }>;
    }
    const manifest = async (version: number) =>
      JSON.parse(
        await readFile(
          new URL(
            `../eval/workload-v${version}/workload.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ) as Manifest;
    const original = await manifest(1);
    const current = await manifest(2);
    expect(current).toEqual({
      ...original,
      version: 2,
      cases: original.cases.map((row) =>
        row.id === "discovery"
          ? {
              ...row,
              instruction:
                "Discover the repository using the glob tool with the exact pattern docs/**, then read docs/inventory.json. Implement its discovery value in src/value.cjs.",
            }
          : row,
      ),
    });
    expect(await qualificationWorkloadHash()).not.toBe(LEGACY_WORKLOAD_HASH);
    expect(await qualificationWorkloadHash()).not.toBe(V2_WORKLOAD_HASH);
    const v2Digests = {
      "README.md":
        "a2e177620d3a16f71f866f70fdc9f5916ca58c7258be10ec645a6939a75ab8b6",
      "acceptance.cjs":
        "b8306d5b7c31b55fcd5c7567a60de455e2fcafa8d7b3784a19171571a77991ab",
      "value.cjs":
        "688506beebc9c05e799857154be43808c81907ff34f05627d8f608d9ab77c4a5",
      "workload.json":
        "9079a462d5cd180c6146cf73cd2f41815c691dcf1bcc38d41b3b8c272aa92d96",
    };
    for (const [name, digest] of Object.entries(v2Digests)) {
      const bytes = await readFile(
        new URL(`../eval/workload-v2/${name}`, import.meta.url),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
      if (name === "acceptance.cjs" || name === "value.cjs")
        expect(
          await readFile(
            new URL(`../eval/workload-v3/${name}`, import.meta.url),
          ),
        ).toEqual(bytes);
    }
    expect(await manifest(3)).toEqual({ ...current, version: 3 });
    const schema = JSON.parse(
      await readFile(
        new URL("../schemas/qualification.schema.json", import.meta.url),
        "utf8",
      ),
    ) as {
      properties: {
        version: { const: number };
        suiteVersion: { enum: number[]; const?: number };
      };
    };
    expect(schema.properties.version.const).toBe(1);
    expect(schema.properties.suiteVersion).toEqual({ enum: [1, 2, 3] });
  });
});

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
const tool=(name,input,exit=undefined,output='',metadata={})=>emit({type:'tool_use',part:{id:'part-'+(++n),callID:'call-'+n,tool:name,state:{status:'completed',input,output,metadata:{...metadata,...(exit===undefined?{}:{exit})}}}});
const command=(path)=>{let exit=0,output='';try{output=cp.execFileSync(process.execPath,[path],{stdio:'pipe',encoding:'utf8'});}catch(error){exit=error.status;output=String(error.stdout)+String(error.stderr);}tool('bash',{command:'node '+path},exit,output);};
round('round-one'); const inventory=fs.readFileSync('docs/inventory.json','utf8'); tool('read',{filePath:'docs/inventory.json'},undefined,inventory);
if(scenario==='discovery'){fs.readdirSync('docs');tool('glob',{pattern:'docs/**'});}
let ledger='';if(scenario==='read-search'||scenario==='multi-round'){if(scenario==='multi-round')round('round-two');ledger=fs.readFileSync('docs/ledger.jsonl','utf8');tool('grep',{pattern:'target-seven',path:'docs/ledger.jsonl'},undefined,ledger.split('\\n').filter(line=>line.includes('target-seven')).join('\\n'));}
if(scenario==='command')command('tools/echo.cjs');
if(scenario==='tool-error-recovery'){command('tools/failure.cjs');command('tools/recover.cjs');}
if(scenario==='test-driven-repair')command('checks/acceptance.cjs');
if(scenario==='multi-round'){
const nl=String.fromCharCode(10),rows=ledger.trimEnd().split(nl),path='docs/ledger.jsonl';
tool('read',{filePath:path},undefined,[ '<path>'+path+'</path>','<type>file</type>','<content>',rows.map((line,i)=>(i+1)+': '+line).join(nl),'','(End of file - total '+rows.length+' lines)','</content>'].join(nl),{truncated:false,display:{type:'file',path,text:rows.join(nl),lineStart:1,lineEnd:rows.length,totalLines:rows.length,truncated:false}});
round('round-three');}
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
        expect(input.timeoutSec).toBe(180);
        expect(input.prompt).toContain("qualification workload v3, case ");
        calls++;
        const scenario = /case ([a-z-]+)\./.exec(input.prompt)?.[1];
        if (!scenario) throw new Error("Unexpected arbitrary prompt");
        if (scenario === "discovery")
          expect(input.prompt).toContain(
            "using the glob tool with the exact pattern docs/**",
          );
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
    expect(result.version).toBe(1);
    expect(result.suiteVersion).toBe(3);
    expect(result.workloadHash).toBe(await qualificationWorkloadHash());
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

    // The strict service parser must preserve fixture-only historical envelopes
    // without regrading them or rewriting their version/hash/evidence fields.
    const data = join(root, "data");
    const store = new Store(data);
    const controller = new Controller(
      {
        version: 1,
        data_dir: data,
        port: 0,
        poll_interval_ms: 1000,
        repositories: [
          { path: result.cases[0]!.worktree!, data_policy: "local-only" },
        ],
        endpoints: [endpoint],
        profiles: [profile],
        default_profile: profile.id,
        allow_checks_only: true,
      },
      store,
      adapter,
    );
    try {
      for (const suiteVersion of [1, 2, 3, 4] as const) {
        const id = `inspection-v${suiteVersion}`;
        const jobRoot = join(data, "qualifications", id);
        await mkdir(jobRoot, { recursive: true, mode: 0o700 });
        store.createQualificationJob({
          id,
          root: jobRoot,
          profileId: profile.id,
        });
        const resultPath = join(jobRoot, "result.json");
        const envelope = {
          ...result,
          suiteVersion,
          ...(suiteVersion === 1
            ? { workloadHash: LEGACY_WORKLOAD_HASH }
            : suiteVersion === 2
              ? { workloadHash: V2_WORKLOAD_HASH }
              : {}),
        };
        const serialized = JSON.stringify(envelope);
        await writeFile(resultPath, serialized, { mode: 0o600 });
        store.finishQualificationJob(id, "completed", resultPath);
        if (suiteVersion === 4)
          await expect(
            controller.qualificationDetail(id),
          ).rejects.toMatchObject({
            code: "QUALIFICATION_RESULT",
          });
        else
          expect((await controller.qualificationDetail(id)).result).toEqual(
            envelope,
          );
        expect(await readFile(resultPath, "utf8")).toBe(serialized);
      }
    } finally {
      store.close();
    }
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
function readPage(
  type: "file" | "directory" = "file",
  offset = 170,
  limit = 10,
  total = 256,
  width = 5,
) {
  const path = type === "file" ? "docs/ledger.jsonl" : "docs";
  const entries = Array.from(
    { length: limit },
    (_, index) => "x".repeat(width) + (offset + index),
  );
  entries[0] = "target-seven " + entries[0];
  const text = entries.join("\n");
  const display: Record<string, unknown> =
    type === "file"
      ? {
          type,
          path,
          text,
          lineStart: offset,
          lineEnd: offset + limit - 1,
          totalLines: total,
          truncated: true,
        }
      : { type, path, entries, offset, totalEntries: total, truncated: true };
  const output =
    type === "file"
      ? `<path>${path}</path>\n<type>file</type>\n<content>\n${entries.map((line, index) => `${offset + index}: ${line}`).join("\n")}\n\n(Showing lines ${offset}-${offset + limit - 1} of ${total}. Use offset=${offset + limit} to continue.)\n</content>`
      : [
          `<path>${path}</path>`,
          "<type>directory</type>",
          "<entries>",
          entries.join("\n"),
          `\n(Showing ${limit} of ${total} entries. Use 'offset' parameter to read beyond entry ${offset + limit})`,
          "</entries>",
        ].join("\n");
  return {
    id: "page",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: path, offset, limit } as Record<string, unknown>,
      output,
      metadata: { truncated: true, display } as Record<string, unknown>,
      structuredOutput: undefined as Record<string, unknown> | undefined,
    },
  };
}
function discoveryWithPage(page: ReturnType<typeof readPage>): string {
  return [
    event("step_start", { id: "one" }),
    event("tool_use", {
      id: "inventory",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "docs/inventory.json" },
        output: "inventory",
      },
    }),
    event("tool_use", {
      id: "glob",
      tool: "glob",
      state: {
        status: "completed",
        input: { pattern: "docs/**" },
        output: "docs/inventory.json",
      },
    }),
    event("tool_use", page),
    event("step_finish", { reason: "stop" }),
  ].join("\n");
}
function wholeLedger() {
  const page = readPage("file", 1, 256, 256, 140);
  const display = page.state.metadata.display as Record<string, unknown>;
  page.state.metadata.truncated = false;
  display.truncated = false;
  page.state.output = page.state.output.replace(
    "(Showing lines 1-256 of 256. Use offset=257 to continue.)",
    "(End of file - total 256 lines)",
  );
  page.id = "whole";
  return page;
}
describe("versioned read-page completeness", () => {
  it.each(["file", "directory"] as const)(
    "accepts a complete explicit %s page only under v3",
    (type) => {
      const trace = discoveryWithPage(readPage(type));
      expect(observeToolEvidence(trace, "discovery").requirementsMet).toBe(
        true,
      );
      for (const version of [1, 2] as const)
        expect(
          observeToolEvidence(trace, "discovery", undefined, version).valid,
        ).toBe(false);
    },
  );
  it.each([undefined, 0, 1])(
    "honors effective first-line offset %s",
    (offset) => {
      const page = readPage("file", 1);
      if (offset === undefined) delete page.state.input.offset;
      else page.state.input.offset = offset;
      expect(
        observeToolEvidence(discoveryWithPage(page), "discovery").valid,
      ).toBe(true);
    },
  );
  it("accepts absolute and relative worktree-root directory pages", () => {
    const worktree = "/fixture/worktree";
    for (const inputPath of [worktree, ".", "./"]) {
      const page = readPage("directory");
      page.state.input.filePath = inputPath;
      (page.state.metadata.display as Record<string, unknown>).path = worktree;
      page.state.output = page.state.output.replace(
        "<path>docs</path>",
        `<path>${worktree}</path>`,
      );
      expect(
        observeToolEvidence(discoveryWithPage(page), "discovery", worktree)
          .valid,
      ).toBe(true);
    }
  });
  it("rejects ambiguous or incomplete directory pages", () => {
    for (const mutate of [
      (page: ReturnType<typeof readPage>) => {
        (page.state.metadata.display as Record<string, unknown>).entries = [];
      },
      (page: ReturnType<typeof readPage>) => {
        (page.state.metadata.display as Record<string, unknown>).offset = 1;
      },
      (page: ReturnType<typeof readPage>) => {
        (page.state.metadata.display as Record<string, unknown>).totalEntries =
          175;
      },
      (page: ReturnType<typeof readPage>) => {
        (page.state.metadata.display as Record<string, unknown>).entries = [
          "ambiguous\nentry",
        ];
      },
      (page: ReturnType<typeof readPage>) => {
        page.state.output = page.state.output.slice(0, -10);
      },
    ]) {
      const page = readPage("directory");
      mutate(page);
      expect(
        observeToolEvidence(discoveryWithPage(page), "discovery").valid,
      ).toBe(false);
    }
  });
  const invalid: Array<[string, (page: ReturnType<typeof readPage>) => void]> =
    [
      [
        "no explicit limit",
        (page) => {
          delete page.state.input.limit;
        },
      ],
      [
        "zero limit",
        (page) => {
          page.state.input.limit = 0;
        },
      ],
      [
        "fractional limit",
        (page) => {
          page.state.input.limit = 1.5;
        },
      ],
      [
        "nonfinite limit",
        (page) => {
          page.state.input.limit = Infinity;
        },
      ],
      [
        "negative offset",
        (page) => {
          page.state.input.offset = -1;
        },
      ],
      [
        "fractional offset",
        (page) => {
          page.state.input.offset = 170.5;
        },
      ],
      [
        "mismatched path",
        (page) => {
          page.state.input.filePath = "docs/other.json";
        },
      ],
      [
        "ambiguous path",
        (page) => {
          page.state.input.path = "docs/other.json";
        },
      ],
      [
        "missing display",
        (page) => {
          delete page.state.metadata.display;
        },
      ],
      [
        "different display flag",
        (page) => {
          (page.state.metadata.display as Record<string, unknown>).truncated =
            false;
        },
      ],
      [
        "incorrect end count",
        (page) => {
          (page.state.metadata.display as Record<string, unknown>).lineEnd =
            180;
        },
      ],
      [
        "inconsistent total",
        (page) => {
          (page.state.metadata.display as Record<string, unknown>).totalLines =
            179;
        },
      ],
      [
        "mismatched content",
        (page) => {
          (page.state.metadata.display as Record<string, unknown>).text =
            "missing page text";
        },
      ],
      [
        "missing footer",
        (page) => {
          page.state.output = page.state.output.slice(0, -10);
        },
      ],
      [
        "copy loss",
        (page) => {
          page.state.output = page.state.output.replace(
            "170: target-seven",
            "170: missing",
          );
        },
      ],
      [
        "byte cap",
        (page) => {
          page.state.output = page.state.output.replace(
            "Showing lines",
            "Output capped at 50 KB. Showing lines",
          );
        },
      ],
      [
        "line truncation",
        (page) => {
          page.state.output = page.state.output.replace(
            "170: target-seven",
            "170: ... (line truncated to 2000 chars)",
          );
        },
      ],
      [
        "metadata timeout",
        (page) => {
          page.state.metadata.timeout = true;
        },
      ],
      [
        "structured timeout",
        (page) => {
          page.state.structuredOutput = { timeout: true };
        },
      ],
      [
        "structured truncation",
        (page) => {
          page.state.structuredOutput = { truncated: true };
        },
      ],
      [
        "non-read truncation",
        (page) => {
          page.tool = "edit";
        },
      ],
      [
        "errored read",
        (page) => {
          page.state.status = "error";
        },
      ],
    ];
  it.each(invalid)(
    "rejects %s without relaxing other tool evidence",
    (_name, mutate) => {
      const page = readPage();
      mutate(page);
      expect(
        observeToolEvidence(discoveryWithPage(page), "discovery").valid,
      ).toBe(false);
    },
  );
  it("rejects true text-byte/line caps and malformed or lost outer streams", () => {
    for (const page of [
      readPage("file", 1, 100, 256, 600),
      readPage("file", 1, 2, 256, 2100),
    ])
      expect(
        observeToolEvidence(discoveryWithPage(page), "discovery").valid,
      ).toBe(false);
    const trace = discoveryWithPage(readPage());
    for (const extra of [
      "\n[spillway: output truncated]",
      "\n{broken",
      '\n{"type":"text","type":"error"}',
    ])
      expect(observeToolEvidence(trace + extra, "discovery").valid).toBe(false);
  });
  it("requires a full ledger read even when a complete large page or EOF tail exceeds 32 KiB", () => {
    const trace = (page: ReturnType<typeof readPage>, whole = false) =>
      [
        event("step_start", { id: "one" }),
        event("tool_use", {
          id: "inventory",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "docs/inventory.json" },
            output: "inventory",
          },
        }),
        event("step_start", { id: "two" }),
        event("tool_use", {
          id: "grep",
          tool: "grep",
          state: {
            status: "completed",
            input: { pattern: "target-seven", path: "docs/ledger.jsonl" },
            output: "target-seven",
          },
        }),
        event("tool_use", page),
        ...(whole ? [event("tool_use", wholeLedger())] : []),
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
    const page = readPage("file", 1, 200, 256, 170);
    const partial = observeToolEvidence(trace(page), "multi-round");
    expect(partial.valid).toBe(true);
    expect(partial.contextBytesObserved).toBeGreaterThanOrEqual(32000);
    expect(partial.requirementsMet).toBe(false);
    expect(
      observeToolEvidence(trace(page, true), "multi-round").requirementsMet,
    ).toBe(true);
    const tail = readPage("file", 40, 200, 256, 170);
    tail.state.metadata.truncated = false;
    expect(
      observeToolEvidence(trace(tail), "multi-round").requirementsMet,
    ).toBe(false);
    const actualWhole = wholeLedger();
    expect(
      observeToolEvidence(trace(actualWhole), "multi-round").requirementsMet,
    ).toBe(true);
    for (const mutation of [
      (read: ReturnType<typeof readPage>) => {
        delete read.state.metadata.display;
      },
      (read: ReturnType<typeof readPage>) => {
        (read.state.metadata.display as Record<string, unknown>).truncated =
          true;
      },
      (read: ReturnType<typeof readPage>) => {
        (read.state.metadata.display as Record<string, unknown>).totalLines =
          300;
      },
      (read: ReturnType<typeof readPage>) => {
        read.state.output = read.state.output.slice(0, -10);
      },
      (read: ReturnType<typeof readPage>) => {
        read.state.input.offset = 40;
      },
      (read: ReturnType<typeof readPage>) => {
        read.state.input.limit = 255;
      },
    ]) {
      const read = wholeLedger();
      mutation(read);
      expect(
        observeToolEvidence(trace(read), "multi-round").requirementsMet,
      ).toBe(false);
    }
  });
});
describe("tool evidence and metadata qualification boundaries", () => {
  it.each(["docs/**", "**/*"])(
    "keeps discovery's exact glob predicate for %s",
    (pattern) => {
      const trace = [
        event("step_start", { id: "round" }),
        event("tool_use", {
          id: "glob",
          tool: "glob",
          state: {
            status: "completed",
            input: { pattern },
            output: "docs/inventory.json",
          },
        }),
        event("tool_use", {
          id: "read",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "docs/inventory.json" },
            output: "inventory",
          },
        }),
        event("step_finish", { reason: "stop" }),
      ].join("\n");
      expect(observeToolEvidence(trace, "discovery").requirementsMet).toBe(
        pattern === "docs/**",
      );
    },
  );
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
