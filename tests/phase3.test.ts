import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startService,type ServiceHandle } from '../src/server.js';
import { GitWorkspace,gitCommand } from '../src/git.js';
import { runProcess } from '../src/process.js';
import { parseTask } from '../src/task.js';
import type { AuditRecord,EvidenceStatus,HarnessAdapter,TaskDetail } from '../src/contracts.js';
import type { Scorecard } from '../src/report.js';
import * as qualification from '../src/qualification.js';
import { fixture } from './helpers.js';

const qualificationProgram = `
const fs=require('node:fs'),cp=require('node:child_process'); const scenario=process.argv[2]; let n=0;
const emit=event=>console.log(JSON.stringify(event)); const round=id=>emit({type:'step_start',part:{id}});
const tool=(name,input,exit,output='')=>emit({type:'tool_use',part:{id:'part-'+(++n),callID:'call-'+n,tool:name,state:{status:'completed',input,output,metadata:exit===undefined?{}:{exit}}}});
const command=path=>{const result=cp.spawnSync(process.execPath,[path],{encoding:'utf8'});tool('bash',{command:'node '+path},result.status,result.stdout+result.stderr);};
round('round-one');const inventory=fs.readFileSync('docs/inventory.json','utf8');tool('read',{filePath:'docs/inventory.json'},undefined,inventory);let ledger;
if(scenario==='discovery'){fs.readdirSync('docs');tool('glob',{pattern:'docs/**'});}
if(scenario==='read-search'||scenario==='multi-round'){if(scenario==='multi-round')round('round-two');ledger=fs.readFileSync('docs/ledger.jsonl','utf8');if(scenario==='multi-round')tool('read',{filePath:'docs/ledger.jsonl'},undefined,ledger);const matches=ledger.split('\\n').filter(line=>line.includes('target-seven')).join('\\n');tool('grep',{pattern:'target-seven',path:'docs/ledger.jsonl'},undefined,matches);}
if(scenario==='command')command('tools/echo.cjs');
if(scenario==='tool-error-recovery'){command('tools/failure.cjs');command('tools/recover.cjs');}
if(scenario==='test-driven-repair')command('checks/acceptance.cjs');
if(scenario==='multi-round')round('round-three');
const expected=scenario==='multi-round'?JSON.parse(ledger.split('\\n').find(line=>line.includes('target-seven'))).value:JSON.parse(inventory)[scenario];
fs.writeFileSync('src/value.cjs','module.exports=()=>('+JSON.stringify(expected)+');\\n');tool('edit',{filePath:'src/value.cjs'});
command('checks/acceptance.cjs');cp.execFileSync('git',['-c','core.hooksPath=/dev/null','add','src/value.cjs']);cp.execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-m','Fixture-only qualification edit']);
emit({type:'step_finish',part:{id:'final',reason:'stop'}});
`;
const completeMetadata = {
  model: 'fixture-model',modelArtifact: 'a'.repeat(64),harnessVersion: '1.2.3',serverVersion: '0.3.1',license: 'Apache-2.0',contextTokens: 8192,
  hardware: { memoryGiB: 32,cpuCores: 8,gpuCount: 1,gpuMemoryGiB: 24 },serverEngine: 'lm-studio',
  settings: { quantization: 'Q4_K_M',temperature: 0.5,seed: null,concurrency: 1 },
};

describe('Phase 3 integrated private service (fixture inference only)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let s: ServiceHandle;
  let adapter: HarnessAdapter;
  let qualificationThrows: boolean;
  let qualificationCalls: number;
  beforeEach(async () => {
    f = await fixture(); f.config.audit_rate = 1; f.config.repositories[0]!.data_policy = 'frontier-ok';
    qualificationThrows = false; qualificationCalls = 0;
    const qualifier = join(f.root,'qualification-fixture.cjs'); await writeFile(qualifier,qualificationProgram);
    adapter = {
      id: 'opencode',async version() { return f.config.profiles[0]!.harness_version; },
      async run(input) {
        if (input.purpose === 'review') {
          const program = "const cp=require('node:child_process');const resultSha=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();console.log(JSON.stringify({resultSha,verdict:'accept',findings:[]}));";
          const result = await runProcess({ command: process.execPath,args: ['-e',program],cwd: input.worktree,timeoutMs: input.timeoutSec*1000,logPath: input.logPath,signal: input.signal });
          return { exit: result.exitCode === 0 ? 'completed' : 'failed',summary: result.stdout.trim(),usage: { inputTokens: 7,outputTokens: 2,costUsd: 0.002 } };
        }
        const scenario = /fixed qualification workload v1, case ([a-z-]+)\./.exec(input.prompt)?.[1];
        if (scenario) {
          qualificationCalls++;
          if (qualificationThrows) throw new Error('Fixture subprocess completion unknown');
          const result = await runProcess({ command: process.execPath,args: [qualifier,scenario],cwd: input.worktree,timeoutMs: input.timeoutSec*1000,logPath: input.logPath,signal: input.signal });
          return { exit: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'completed' : 'failed',usage: { inputTokens: 10,outputTokens: 2 } };
        }
        return { ...await f.adapter.run(input),usage: { inputTokens: 10,outputTokens: 3,costUsd: 0.001 } };
      },
    };
    s = await startService(f.config,{ once: true,adapter });
  });
  afterEach(async () => { vi.restoreAllMocks(); await s.close(); await f.cleanup(); });
  async function api<T>(path: string,body?: unknown): Promise<{status: number; data: T | undefined; error?: {code: string; message: string}}> {
    const response = await fetch(s.url+path,{ method: body === undefined ? 'GET' : 'POST',headers: { Authorization: `Bearer ${s.token}`,'Content-Type': 'application/json' },...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const parsed = await response.json() as {data?: T; error?: {code: string; message: string}};
    return { status: response.status,data: parsed.data,error: parsed.error };
  }
  async function ready(id = 'ordinary',review = 'default') {
    expect((await api('/api/v1/tasks',{ markdown: f.markdown(id,review) })).status).toBe(201);
    expect((await api('/api/v1/run',{})).status).toBe(200);
    if (review !== 'checks-only') expect((await api('/api/v1/run',{})).status).toBe(200);
    const task = (await api<TaskDetail>(`/api/v1/tasks/${id}`)).data!; expect(task.task.state).toBe('ready'); return task;
  }
  async function accept(id = 'ordinary',minutes = 3.25) {
    expect((await api(`/api/v1/tasks/${id}/decision`,{ decision: 'accepted',ownerMinutes: minutes })).status).toBe(200);
    return s.store.listAudits(id)[0]!;
  }
  const report = (sha: string,verdict: 'accept' | 'needs-repair' | 'reject' = 'accept') => ({ resultSha: sha,verdict,findings: verdict === 'accept' ? [{ severity: 'warning',message: 'Fixture warning is not a blocking miss' }] : [{ severity: 'blocking',message: 'Fixture missing boundary' }] });

  it('records ordinary local work, owner minutes, forced audit selection and reported frontier roles separately', async () => {
    const detail = await ready(); expect(detail.task).toMatchObject({ origin: 'ordinary',completedWhileFrontierOff: true,policySnapshot: { version: 1 } }); expect(detail.task.readyAt).toEqual(expect.any(String));
    expect(detail.attempts[0]?.verification?.passed).toBe(true); expect(detail.reviews?.[0]).toMatchObject({ source: 'service-local',report: { verdict: 'accept' } });
    const audit = await accept(); expect(audit.status).toBe('pending'); expect(s.store.getDecision('ordinary')?.ownerMinutes).toBe(3.25);
    expect((await api('/api/v1/tasks/ordinary/planning-usage',{ usage: { inputTokens: 5 } })).status).toBe(200);
    expect((await api('/api/v1/frontier',{ available: true })).status).toBe(200);
    expect((await api(`/api/v1/audits/${audit.id}/report`,{ report: report(audit.resultSha),model: 'owner-attested-fixture',usage: { inputTokens: 4,outputTokens: 1 } })).status).toBe(200);
    const score = (await api<Scorecard>('/api/v1/report')).data!;
    expect(score.tasks).toMatchObject({ total: 1,accepted: 1,recordedDecisions: 1,acceptedWhileFrontierOff: { yes: 1,no: 0,unknown: 0 } });
    expect(score.ownerMinutes).toEqual({ total: 3.25,known: 1,missing: 0 }); expect(score.tasks.acceptance.percent).toBeNull();
    expect(score.usage.worker.inputTokens.total).toBe(10); expect(score.usage.review.inputTokens.total).toBe(7); expect(score.frontierUsage.review.inputTokens.total).toBe(0);
    expect(score.frontierUsage.planning.inputTokens.total).toBe(5); expect(score.frontierUsage.planning.outputTokens.missing).toBe(1); expect(score.frontierUsage.audit.inputTokens.total).toBe(4);
    expect(score.audits).toMatchObject({ selected: 1,completed: 1,misses: 0,pending: 0,missRate: { percent: null } });
  });
  it('rate zero never selects audits, preserves unknown legacy readiness and excludes qualification tasks', async () => {
    f.config.audit_rate = 0; await ready('modern','checks-only'); await accept('modern'); expect(s.store.listAudits()).toEqual([]);
    const modern = s.store.getTask('modern')!;
    const db = new DatabaseSync(join(f.data,'queue.sqlite')); db.prepare('UPDATE tasks SET ready_at=NULL,completed_frontier_off=NULL WHERE id=?').run('modern'); db.close();
    const score = (await api<Scorecard>('/api/v1/report')).data!;
    expect(score.tasks.acceptedWhileFrontierOff).toEqual({ yes: 0,no: 0,unknown: 1 }); expect(modern.completedWhileFrontierOff).toBe(true);
    const qualificationRaw = f.markdown('qualification-task','checks-only');
    const qualificationTask = s.store.addTask(parseTask(qualificationRaw),qualificationRaw,'fixture','checks-only',{ origin: 'qualification' });
    expect(qualificationTask.origin).toBe('qualification'); await s.controller.runOnce(); await s.controller.decide('qualification-task','accepted');
    const excluded = (await api<Scorecard>('/api/v1/report')).data!; expect(excluded.qualificationExcluded).toBe(1); expect(excluded.tasks.total).toBe(1);
  });
  it('syncs HTTP mutations to the exact outbox prefix and restarts without duplicate JSONL', async () => {
    await ready(); await accept();
    const sync = await api<EvidenceStatus>('/api/v1/evidence/sync',{}); expect(sync.data).toMatchObject({ pending: 0,lastError: null });
    const records = s.store.listEvidence(0,1000); const expected = records.map(row => JSON.stringify(row)+'\n').join(''); const path = join(f.data,'evidence.jsonl'); expect(await readFile(path,'utf8')).toBe(expected);
    await s.close(); s = await startService(f.config,{ once: true,adapter });
    expect((await api<EvidenceStatus>('/api/v1/evidence/sync',{})).data).toMatchObject({ pending: 0,lastError: null }); expect(await readFile(path,'utf8')).toBe(expected);
    expect(s.store.getDecision('ordinary')?.decision).toBe('accepted'); expect(s.store.listAudits()).toHaveLength(1);
  });
  it('keeps denied audits pending and retains denominators while frontier is off or repo permission is revoked', async () => {
    await ready(); const audit = await accept();
    expect((await api<(AuditRecord & {held: boolean})[]>('/api/v1/audits')).data?.[0]?.held).toBe(true);
    expect((await api(`/api/v1/audits/${audit.id}/packet`)).status).toBe(409); expect((await api(`/api/v1/audits/${audit.id}/report`,{ report: report(audit.resultSha) })).status).toBe(409);
    await api('/api/v1/frontier',{ available: true }); f.config.repositories[0]!.data_policy = 'local-only';
    expect((await api(`/api/v1/audits/${audit.id}/packet`)).status).toBe(403); expect((await api(`/api/v1/audits/${audit.id}/report`,{ report: report(audit.resultSha) })).status).toBe(403);
    expect(s.store.getAudit(audit.id)).toEqual(audit); expect((await api<Scorecard>('/api/v1/report')).data?.audits).toMatchObject({ selected: 1,completed: 0,pending: 1 });
  });
  it('audits immutable accepted objects after normal merge and result worktree/branch removal, denying stale SHA and replay', async () => {
    const detail = await ready(); const audit = await accept(); const decision = s.store.getDecision('ordinary'); const task = s.store.getTask('ordinary'); const a = detail.attempts[0]!;
    await gitCommand(f.repo,['merge','--ff-only',a.branch]); await gitCommand(f.repo,['worktree','remove',a.worktree]); await gitCommand(f.repo,['branch','-D',a.branch]); await api('/api/v1/frontier',{ available: true });
    const packet = await api<{resultSha: string; diff: string}>(`/api/v1/audits/${audit.id}/packet`); expect(packet.status).toBe(200); expect(packet.data?.resultSha).toBe(audit.resultSha); expect(packet.data?.diff).toContain("hello");
    expect((await api(`/api/v1/audits/${audit.id}/report`,{ report: report('c'.repeat(40)) })).status).toBe(409); expect(s.store.getAudit(audit.id)?.status).toBe('pending');
    expect((await api(`/api/v1/audits/${audit.id}/report`,{ report: report(audit.resultSha,'needs-repair') })).status).toBe(200); const completed = s.store.getAudit(audit.id);
    expect((await api(`/api/v1/audits/${audit.id}/report`,{ report: report(audit.resultSha) })).status).toBe(409);
    expect(s.store.getAudit(audit.id)).toEqual(completed); expect(s.store.getDecision('ordinary')).toEqual(decision); expect(s.store.getTask('ordinary')).toEqual(task);
    expect((await api<Scorecard>('/api/v1/report')).data?.audits).toMatchObject({ completed: 1,misses: 1,pending: 0 });
  });
  it.each(['off','policy'])('rechecks %s after awaited audit diff preparation and does not rewrite accepted history', async race => {
    await ready(); const audit = await accept(); await api('/api/v1/frontier',{ available: true }); const task = s.store.getTask('ordinary'); const decision = s.store.getDecision('ordinary');
    const diff = GitWorkspace.prototype.diff;
    vi.spyOn(GitWorkspace.prototype,'diff').mockImplementationOnce(async function(this: GitWorkspace,base,result) {
      const resultDiff = await diff.call(this,base,result);
      if (race === 'off') s.store.setFrontierState(false); else f.config.repositories[0]!.data_policy = 'local-only';
      return resultDiff;
    });
    expect((await api(`/api/v1/audits/${audit.id}/report`,{ report: report(audit.resultSha) })).status).toBe(race === 'off' ? 409 : 403);
    expect(s.store.getAudit(audit.id)).toEqual(audit); expect(s.store.getTask('ordinary')).toEqual(task); expect(s.store.getDecision('ordinary')).toEqual(decision);
  });
  it('keeps accepted object audit independent of later edited worker residue', async () => {
    const detail = await ready(); const audit = await accept(); await writeFile(join(detail.attempts[0]!.worktree,'src/message.cjs'),"module.exports=()=> 'mutated residue';\n");
    await api('/api/v1/frontier',{ available: true }); const packet = await api<{diff: string}>(`/api/v1/audits/${audit.id}/packet`);
    expect(packet.status).toBe(200); expect(packet.data?.diff).toContain('hello'); expect(packet.data?.diff).not.toContain('mutated residue');
  });
  it('observes seven fixture qualification cases through real subprocesses without promoting the configured profile', async () => {
    f.config.profiles[0]!.harness_version = '1.2.3'; f.config.profiles[0]!.model_artifact = completeMetadata.modelArtifact; const classes = [...f.config.profiles[0]!.qualified_classes];
    const qualified = await api<{jobId: string; result: qualification.QualificationResult}>('/api/v1/qualify',{ profileId: 'fixture',metadata: completeMetadata });
    expect(qualified.status).toBe(200); expect(qualificationCalls).toBe(7); for (const row of qualified.data!.result.cases) expect(row.outcome,`${row.capability}: ${row.reason} ${JSON.stringify(row.observations)}`).toBe('passed');
    expect(qualified.data?.result).toMatchObject({ provenance: 'fixture',qualified: false,metadataComplete: true }); expect(qualified.data?.result.failures).toContain('fixture-provenance');
    expect(f.config.profiles[0]!.qualified_classes).toEqual(classes); expect(s.store.getQualificationJob(qualified.data!.jobId)?.status).toBe('completed'); expect((await api<Scorecard>('/api/v1/report')).data?.tasks.total).toBe(0);
  });
  it('rejects nonfinite raw JSON usage before frontier review, audit or planning mutations', async () => {
    await api('/api/v1/frontier',{ available: true });
    await api('/api/v1/tasks',{ markdown: f.markdown('frontier-number','frontier') }); await api('/api/v1/run',{});
    const frontierSha = s.controller.getDetail('frontier-number').attempts[0]!.resultSha!;
    await ready(); const audit = await accept(); const ordinary = s.controller.getDetail('ordinary'); const frontier = s.controller.getDetail('frontier-number'); const evidence = s.store.evidenceCounts();
    const malformed = async (path: string,raw: string) => fetch(s.url+path,{ method: 'POST',headers: { Authorization: `Bearer ${s.token}`,'Content-Type': 'application/json' },body: raw });
    expect((await malformed('/api/v1/tasks/frontier-number/review',`{"report":${JSON.stringify(report(frontierSha))},"usage":{"costUsd":1e400}}`)).status).toBe(400);
    expect((await malformed(`/api/v1/audits/${audit.id}/report`,`{"report":${JSON.stringify(report(audit.resultSha))},"usage":{"costUsd":1e400}}`)).status).toBe(400);
    expect((await malformed('/api/v1/tasks/ordinary/planning-usage','{"usage":{"costUsd":1e400}}')).status).toBe(400);
    expect(s.controller.getDetail('frontier-number')).toEqual(frontier); expect(s.controller.getDetail('ordinary')).toEqual(ordinary);
    expect(s.store.listReviews('frontier-number')).toEqual([]); expect(s.store.getAudit(audit.id)).toEqual(audit); expect(s.store.listPlanningUsage()).toEqual([]);
    expect(s.store.evidenceCounts().pending+s.store.evidenceCounts().delivered).toBe(evidence.pending+evidence.delivered);
  });
  it('rejects invalid qualification metadata before recording a job or launching a subprocess', async () => {
    const evidence = s.store.evidenceCounts();
    expect((await api('/api/v1/qualify',{ profileId: 'fixture',metadata: { unknown: true } })).status).toBe(400);
    expect(qualificationCalls).toBe(0); expect(s.store.listQualificationJobs()).toEqual([]);
    expect(s.store.evidenceCounts().pending+s.store.evidenceCounts().delivered).toBe(evidence.pending+evidence.delivered);
  });
  it('fences returned uncertain qualification across restart until explicit owner-stop reconciliation', async () => {
    qualificationThrows = true;
    const qualified = await api<{jobId: string; result: qualification.QualificationResult}>('/api/v1/qualify',{ profileId: 'fixture' }); expect(qualified.status).toBe(200); expect(qualified.data?.result.uncertain).toBe(true); expect(qualificationCalls).toBe(1);
    const id = qualified.data!.jobId; const job = s.store.getQualificationJob(id)!; expect(job.status).toBe('uncertain'); expect(job.resultPath).not.toBeNull();
    await api('/api/v1/tasks',{ markdown: f.markdown('after-qualification','checks-only') }); expect((await api<{taskId: string | null}>('/api/v1/run',{})).data?.taskId).toBeNull(); expect(s.store.listAttempts('after-qualification')).toEqual([]);
    await s.close(); s = await startService(f.config,{ once: true,adapter }); expect(s.store.getQualificationJob(id)).toEqual(job); expect((await api('/api/v1/qualify',{ profileId: 'fixture' })).status).toBe(409);
    expect((await api(`/api/v1/qualifications/${id}/reconcile`,{ worker_stopped: false })).status).toBe(400); expect((await api(`/api/v1/qualifications/${id}/reconcile`,{ worker_stopped: true })).status).toBe(200);
    expect(s.store.getQualificationJob(id)?.status).toBe('uncertain'); expect(s.store.getQualificationJob(id)?.reconciledAt).not.toBeNull(); expect((await api('/api/v1/run',{})).data).toEqual({ taskId: 'after-qualification' });
  });
  it('retains an uncertain durable job on an unexpected outer qualification exception', async () => {
    const run = qualification.runQualification;
    vi.spyOn(qualification,'runQualification').mockImplementationOnce(async input => { await run(input); throw new Error('Fixture outer result-finalization interruption'); });
    expect((await api('/api/v1/qualify',{ profileId: 'fixture' })).status).toBe(409); const job = s.store.listQualificationJobs()[0]!;
    expect(job.status).toBe('uncertain'); expect(job.reconciledAt).toBeNull(); expect(s.store.hasUnresolvedExecution()).toBe(true);
    await api('/api/v1/tasks',{ markdown: f.markdown('later','checks-only') }); expect((await api<{taskId: string | null}>('/api/v1/run',{})).data?.taskId).toBeNull();
    expect(s.store.listAttempts('later')).toEqual([]); expect((await api(`/api/v1/qualifications/${job.id}/reconcile`,{ worker_stopped: true })).status).toBe(200); expect(s.store.getQualificationJob(job.id)?.status).toBe('uncertain');
  });
},30000);
