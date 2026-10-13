import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planConfig } from "../src/config.js";
import type { DoctorReport } from "../src/doctor.js";
import type { HarnessAdapter, SpillwayConfig } from "../src/contracts.js";
import type { QualificationResult } from "../src/qualification.js";
import { runProcess } from "../src/process.js";
import { startService, type ServiceHandle } from "../src/server.js";
import { fixture } from "./helpers.js";

const qualificationProgram = `
const fs=require('node:fs'),cp=require('node:child_process'); const scenario=process.argv[2]; let n=0;
const emit=event=>console.log(JSON.stringify(event)); const round=id=>emit({type:'step_start',part:{id}});
const tool=(name,input,exit,output='',metadata={})=>emit({type:'tool_use',part:{id:'part-'+(++n),callID:'call-'+n,tool:name,state:{status:'completed',input,output,metadata:{...metadata,...(exit===undefined?{}:{exit})}}}});
const command=path=>{const result=cp.spawnSync(process.execPath,[path],{encoding:'utf8'});tool('bash',{command:'node '+path},result.status,result.stdout+result.stderr);};
round('round-one');const inventory=fs.readFileSync('docs/inventory.json','utf8');tool('read',{filePath:'docs/inventory.json'},undefined,inventory);let ledger;
if(scenario==='discovery'){fs.readdirSync('docs');tool('glob',{pattern:'docs/**'});}
if(scenario==='read-search'||scenario==='multi-round'){if(scenario==='multi-round')round('round-two');ledger=fs.readFileSync('docs/ledger.jsonl','utf8');if(scenario==='multi-round'){const lines=ledger.split('\\n');if(lines.at(-1)==='')lines.pop();const text=lines.join('\\n');const output='<path>docs/ledger.jsonl</path>\\n<type>file</type>\\n<content>\\n'+lines.map((line,index)=>(index+1)+': '+line).join('\\n')+'\\n\\n(End of file - total '+lines.length+' lines)\\n</content>';tool('read',{filePath:'docs/ledger.jsonl'},undefined,output,{truncated:false,display:{type:'file',path:'docs/ledger.jsonl',text,lineStart:1,lineEnd:lines.length,totalLines:lines.length,truncated:false}});} const matches=ledger.split('\\n').filter(line=>line.includes('target-seven')).join('\\n');tool('grep',{pattern:'target-seven',path:'docs/ledger.jsonl'},undefined,matches);}
if(scenario==='command')command('tools/echo.cjs');
if(scenario==='tool-error-recovery'){command('tools/failure.cjs');command('tools/recover.cjs');}
if(scenario==='test-driven-repair')command('checks/acceptance.cjs');
if(scenario==='multi-round')round('round-three');
const expected=scenario==='multi-round'?JSON.parse(ledger.split('\\n').find(line=>line.includes('target-seven'))).value:JSON.parse(inventory)[scenario];
fs.writeFileSync('src/value.cjs','module.exports=()=>('+JSON.stringify(expected)+');\\n');tool('edit',{filePath:'src/value.cjs'});
command('checks/acceptance.cjs');cp.execFileSync('git',['-c','core.hooksPath=/dev/null','add','src/value.cjs']);cp.execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-m','Fixture-only qualification edit']);
emit({type:'step_finish',part:{id:'final',reason:'stop'}});
`;

describe("empty task-class grants", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let s: ServiceHandle;
  let config: SpillwayConfig;
  let qualificationCalls: number;
  let workerCalls: number;
  let reviewCalls: number;
  beforeEach(async () => {
    f = await fixture();
    f.config.profiles[0]!.qualified_classes = [];
    f.config.profiles[0]!.harness_version = "1.2.3";
    f.config.profiles[0]!.model_artifact = "a".repeat(64);
    config = await planConfig({ ...f.config, port: 7433 });
    config.port = 0; // Isolated HTTP fixture chooses an available loopback port.
    qualificationCalls = workerCalls = reviewCalls = 0;
    const script = join(f.root, "qualification-fixture.cjs");
    await writeFile(script, qualificationProgram);
    const adapter: HarnessAdapter = {
      id: "opencode",
      async version() {
        return "1.2.3";
      },
      async run(input) {
        if (input.purpose === "review") {
          reviewCalls++;
          throw new Error("A reviewer without grants must never launch");
        }
        const scenario =
          /fixed qualification workload v3, case ([a-z-]+)\./.exec(
            input.prompt,
          )?.[1];
        if (!scenario) {
          workerCalls++;
          return f.adapter.run(input);
        }
        qualificationCalls++;
        const result = await runProcess({
          command: process.execPath,
          args: [script, scenario],
          cwd: input.worktree,
          timeoutMs: input.timeoutSec * 1000,
          logPath: input.logPath,
          signal: input.signal,
        });
        return {
          exit: result.timedOut
            ? "timeout"
            : result.exitCode === 0
              ? "completed"
              : "failed",
        };
      },
    };
    s = await startService(config, { once: true, adapter });
  });
  afterEach(async () => {
    await s?.close();
    await f?.cleanup();
  });
  async function api<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data?: T; error?: { code: string } }> {
    const response = await fetch(s.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${s.token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      ...((await response.json()) as { data?: T; error?: { code: string } }),
    };
  }
  it("starts the planned profile and doctor without granting admission to any default local class", async () => {
    expect(config.profiles[0]!.qualified_classes).toEqual([]);
    const doctor = await api<DoctorReport>("/api/v1/doctor");
    expect(doctor.status).toBe(200);
    expect(doctor.data?.ok).toBe(true);
    expect(
      doctor.data?.checks.find((row) => row.id === "qualification")?.status,
    ).toBe("warning");
    for (const taskClass of [
      "mechanical",
      "tests",
      "small-fix",
      "small-feature",
    ]) {
      const response = await api("/api/v1/tasks", {
        markdown: f
          .markdown("denied-" + taskClass, "default")
          .replace("class: mechanical", "class: " + taskClass),
      });
      expect(response.error?.code).toBe("UNQUALIFIED_CLASS");
      expect(response.status).toBe(400);
    }
    expect(s.store.listTasks()).toEqual([]);
    expect(await s.controller.runOnce()).toBeNull();
    expect(workerCalls + reviewCalls + qualificationCalls).toBe(0);
  });
  it("admits explicit seven-case qualification with real protected checks and leaves grants empty", async () => {
    const response = await api<{ jobId: string; result: QualificationResult }>(
      "/api/v1/qualify",
      { profileId: "fixture" },
    );
    expect(response.status).toBe(200);
    const result = response.data!.result;
    expect(result.provenance).toBe("fixture");
    expect(result.suiteVersion).toBe(3);
    expect(result.qualified).toBe(false);
    expect(result.uncertain).toBe(false);
    expect(result.cases).toHaveLength(7);
    for (const row of result.cases) {
      expect(row.outcome, row.capability).toBe("passed");
      expect(row.observations.requirementsMet, row.capability).toBe(true);
      expect(row.verification?.passed, row.capability).toBe(true);
      expect(row.resultSha, row.capability).toMatch(/^[a-f0-9]{40}$/);
    }
    expect(qualificationCalls).toBe(7);
    expect(workerCalls + reviewCalls).toBe(0);
    expect(config.profiles[0]!.qualified_classes).toEqual([]);
    expect(s.store.getQualificationJob(response.data!.jobId)?.status).toBe(
      "completed",
    );
    expect(s.store.listTasks()).toEqual([]);
    expect(
      (
        await api("/api/v1/tasks", {
          markdown: f.markdown("after-qualification", "default"),
        })
      ).error?.code,
    ).toBe("UNQUALIFIED_CLASS");
  }, 30_000);
  it("revoking grants holds an already banked worker before creating an attempt", async () => {
    config.profiles[0]!.qualified_classes = ["mechanical"];
    expect(
      (
        await api("/api/v1/tasks", {
          markdown: f.markdown("revoked-dispatch", "default"),
        })
      ).status,
    ).toBe(201);
    config.profiles[0]!.qualified_classes = [];
    expect(
      (await api<{ taskId: string | null }>("/api/v1/run", {})).data?.taskId,
    ).toBeNull();
    expect(s.store.getTask("revoked-dispatch")?.state).toBe("held");
    expect(s.store.listAttempts("revoked-dispatch")).toEqual([]);
    expect(workerCalls + reviewCalls + qualificationCalls).toBe(0);
  });
  it("revoking grants holds a pending local review before calling the adapter", async () => {
    config.profiles[0]!.qualified_classes = ["mechanical"];
    expect(
      (
        await api("/api/v1/tasks", {
          markdown: f.markdown("revoked-review", "default"),
        })
      ).status,
    ).toBe(201);
    expect(
      (await api<{ taskId: string | null }>("/api/v1/run", {})).data?.taskId,
    ).toBe("revoked-review");
    expect(s.store.getTask("revoked-review")?.nextAction).toBe("review");
    expect(
      s.store.listAttempts("revoked-review")[0]?.verification?.passed,
    ).toBe(true);
    config.profiles[0]!.qualified_classes = [];
    expect(
      (await api<{ taskId: string | null }>("/api/v1/run", {})).data?.taskId,
    ).toBeNull();
    expect(s.store.getTask("revoked-review")?.state).toBe("held");
    expect(s.store.listReviews("revoked-review")).toEqual([]);
    expect(workerCalls).toBe(1);
    expect(reviewCalls + qualificationCalls).toBe(0);
  });
});
