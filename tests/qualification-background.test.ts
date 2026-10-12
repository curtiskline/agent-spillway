import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { chmod,link,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startService,type ServiceHandle } from '../src/server.js';
import { runProcess } from '../src/process.js';
import type { HarnessAdapter,QualificationJobRecord } from '../src/contracts.js';
import * as qualification from '../src/qualification.js';
import { fixture } from './helpers.js';

describe('durable background qualification admission (fixture inference only)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let s: ServiceHandle;
  let release: () => void;
  let started: Promise<void>;
  let qualificationCalls: number;
  beforeEach(async () => {
    f = await fixture(); qualificationCalls = 0;
    let notifyStarted: () => void = () => {};
    started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const adapter: HarnessAdapter = {
      id: 'opencode',version: () => f.adapter.version(),
      async run(input) {
        if (!input.prompt.includes('fixed qualification workload v1, case ')) return f.adapter.run(input);
        qualificationCalls++;
        if (qualificationCalls === 1) { notifyStarted(); await gate; }
        const outcome = await runProcess({ command: process.execPath,args: ['-e',"console.log('Fixture-only known unsuccessful tool workload');process.exit(1);"],cwd: input.worktree,timeoutMs: input.timeoutSec*1000,logPath: input.logPath,signal: input.signal });
        return { exit: outcome.timedOut ? 'timeout' : outcome.exitCode === 0 ? 'completed' : 'failed' };
      },
    };
    s = await startService(f.config,{ once: true,adapter });
  });
  afterEach(async () => { release(); vi.restoreAllMocks(); await s.close(); await f.cleanup(); });
  async function api<T>(path: string,body?: unknown) {
    const response = await fetch(s.url+path,{ method: body === undefined ? 'GET' : 'POST',headers: { Authorization: `Bearer ${s.token}`,'Content-Type': 'application/json' },signal: AbortSignal.timeout(5000),...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as {data?: T; error?: {code: string; message: string}};
    return { status: response.status,...result };
  }
  async function detail(id: string) { return api<{job: QualificationJobRecord; result: qualification.QualificationResult | null}>(`/api/v1/qualifications/${id}`); }

  it('returns persisted HTTP202 admission before the gated subprocess completes and fences concurrent inference', async () => {
    const admission = await api<{job: QualificationJobRecord}>('/api/v1/qualify',{ profileId: 'fixture',background: true });
    expect(admission.status).toBe(202); const id = admission.data!.job.id;
    expect(s.store.getQualificationJob(id)?.status).toBe('running'); expect(admission.data!.job.resultPath).toBeNull();
    expect((await detail(id)).data).toMatchObject({ job: { id,status: 'running' },result: null });
    await vi.waitFor(async () => { await Promise.race([started,new Promise<void>((_resolve,reject) => setTimeout(() => reject(new Error('Fixture qualification has not reached the gate')),100))]); },{ timeout: 5000,interval: 50 });
    expect((await api('/api/v1/qualify',{ profileId: 'fixture',background: true })).status).toBe(409); expect(s.store.listQualificationJobs()).toHaveLength(1);
    expect((await api('/api/v1/tasks',{ markdown: f.markdown('queued-after-qualification') })).status).toBe(201);
    expect((await api('/api/v1/run',{})).status).toBe(409); expect(s.store.listAttempts('queued-after-qualification')).toEqual([]);
    release();
    await vi.waitFor(async () => { expect((await detail(id)).data?.job.status).toBe('completed'); },{ timeout: 15000,interval: 100 });
    const completed = (await detail(id)).data!;
    expect(completed.result).toMatchObject({ provenance: 'fixture',qualified: false,uncertain: false }); expect(completed.result?.cases).toHaveLength(7); expect(qualificationCalls).toBe(7);
    expect(completed.job.resultPath).not.toBeNull(); expect(completed.job.endedAt).not.toBeNull(); expect(f.config.profiles[0]!.qualified_classes).toEqual(['mechanical','tests','risky']);
    await s.controller.waitForIdle(); expect((await api('/api/v1/run',{})).data).toEqual({ taskId: 'queued-after-qualification' });
    const resultPath = completed.job.resultPath!; const original = await readFile(resultPath); const raw = original.toString('utf8'); const persisted = s.store.getQualificationJob(id);
    const restore = async () => { await rm(resultPath,{ force: true }); await writeFile(resultPath,original,{ flag: 'wx',mode: 0o600 }); };
    const unavailable = async () => {
      const rejected = await detail(id); expect(rejected.status).toBe(409); expect(rejected.data).toBeUndefined(); expect(rejected.error?.code).toBe('QUALIFICATION_RESULT'); expect(rejected.error?.message).not.toContain(f.root);
      expect(s.store.getQualificationJob(id)).toEqual(persisted);
    };
    const nonfinite = raw.replace(/"durationMs":\s*\d+/, '"durationMs":1e400'); expect(nonfinite).toContain('1e400');
    const altered: unknown = JSON.parse(raw); const typed = altered as Record<string,unknown>;
    for (const content of [raw.replace(/}\s*$/, ',"version":1}'),nonfinite,JSON.stringify({ ...typed,profileId: 'wrong-profile' }),JSON.stringify({ ...typed,qualified: true }),JSON.stringify({ ...typed,unexpected: true })]) {
      try { await writeFile(resultPath,content); await unavailable(); } finally { await restore(); }
      expect((await detail(id)).status).toBe(200);
    }
    const target = join(f.root,'private-result-target'); await writeFile(target,original,{ mode: 0o600 });
    for (const substitute of [() => symlink(target,resultPath),() => link(target,resultPath)]) {
      try { await rm(resultPath); await substitute(); await unavailable(); expect(await readFile(target)).toEqual(original); } finally { await restore(); }
    }
    try { await chmod(resultPath,0o644); await unavailable(); } finally { await restore(); }
    try { await chmod(completed.job.root,0o755); await unavailable(); } finally { await chmod(completed.job.root,0o700); await restore(); }
    try { await writeFile(resultPath,Buffer.alloc(1024*1024+1,120)); await unavailable(); } finally { await restore(); }
    expect((await detail(id)).data?.result).toEqual(completed.result);
  });

  it.each([
    { profileId: 'missing',background: true },
    { profileId: 'fixture',metadata: { unknown: true },background: true },
  ])('rejects invalid pre-admission input without a job or subprocess: %j', async input => {
    expect((await api('/api/v1/qualify',input)).status).toBe(400); expect(s.store.listQualificationJobs()).toEqual([]); expect(qualificationCalls).toBe(0);
    expect((await detail('qualification-missing')).status).toBe(404); expect(s.store.hasUnresolvedExecution()).toBe(false);
  });

  it('consumes an outer background exception while retaining a durable uncertain job and null result', async () => {
    vi.spyOn(qualification,'runQualification').mockRejectedValueOnce(new Error('Fixture outer qualification interruption'));
    const unhandled: unknown[] = []; const observe = (error: unknown) => { unhandled.push(error); }; process.on('unhandledRejection',observe);
    try {
      const admission = await api<{job: QualificationJobRecord}>('/api/v1/qualify',{ profileId: 'fixture',background: true }); expect(admission.status).toBe(202); const id = admission.data!.job.id;
      await vi.waitFor(async () => { expect((await detail(id)).data?.job.status).toBe('uncertain'); },{ timeout: 5000,interval: 50 });
      const interrupted = (await detail(id)).data!; expect(interrupted.result).toBeNull(); expect(interrupted.job.resultPath).toBeNull(); expect(interrupted.job.reconciledAt).toBeNull(); expect(s.store.hasUnresolvedExecution()).toBe(true);
      expect((await api('/api/v1/qualify',{ profileId: 'fixture',background: true })).status).toBe(409); expect(s.store.listQualificationJobs()).toHaveLength(1);
      await new Promise<void>(resolve => setImmediate(resolve)); expect(unhandled).toEqual([]); expect(qualificationCalls).toBe(0);
    } finally { process.off('unhandledRejection',observe); }
  });
},30000);
