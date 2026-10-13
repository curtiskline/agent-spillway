import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { appendFile,chmod,link,mkdtemp,readFile,rm,symlink,truncate,writeFile } from 'node:fs/promises';
import { readFileSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { flushEvidence } from '../src/evidence.js';
import { parseTask } from '../src/task.js';
let root: string; let store: Store; let path: string;
const task = () => parseTask('---\nid: evidence-task\nrepo: /fixture\nbase: main\nclass: tests\nscope: [src/**]\ncontext: [src/file.ts]\nchecks: [npm test]\n---\n## Objective\nFix it.\n## Acceptance criteria\nTest it.\n');
const expected = () => store.listEvidence(0,1000).map(record => JSON.stringify(record)+'\n').join('');
beforeEach(async () => { root = await mkdtemp(join(tmpdir(),'spillway-evidence-')); store = new Store(join(root,'data')); path = join(store.dataDir,'evidence.jsonl'); store.addTask(task(),'private fixture Markdown','fixture','local'); });
afterEach(async () => { vi.restoreAllMocks(); store.close(); await rm(root,{ recursive: true,force: true }); });

describe('crash-safe private evidence delivery', () => {
  it('writes ordered exact snapshots privately, fsyncs before acknowledgement and avoids duplicates', async () => {
    const wanted = expected(); const original = store.acknowledgeEvidence.bind(store);
    const ack = vi.spyOn(store,'acknowledgeEvidence').mockImplementation(id => { expect(readFileSync(path,'utf8')).toBe(wanted); original(id); });
    const status = await flushEvidence(store,store.dataDir); expect(status).toMatchObject({ pending: 0,lastError: null }); expect(ack).toHaveBeenCalledOnce();
    expect((statSync(path).mode & 0o777)).toBe(0o600); expect(await readFile(path,'utf8')).toBe(wanted);
    ack.mockRestore(); await flushEvidence(store,store.dataDir); expect(await readFile(path,'utf8')).toBe(wanted);
  });
  it('recovers complete-write-before-ack after actual reopen without replay duplicates', async () => {
    const wanted = expected(); const failed = vi.spyOn(store,'acknowledgeEvidence').mockImplementationOnce(() => { throw new Error('fixture crash before acknowledgement'); });
    const status = await flushEvidence(store,store.dataDir); expect(status.pending).toBeGreaterThan(0); expect(status.lastError).toMatch(/delivery failed/); expect(await readFile(path,'utf8')).toBe(wanted);
    failed.mockRestore(); store.close(); store = new Store(join(root,'data')); expect((await flushEvidence(store,store.dataDir)).pending).toBe(0); expect(await readFile(path,'utf8')).toBe(wanted);
  });
  it('recovers only an incomplete pending tail, including partial UTF-8 bytes', async () => {
    await flushEvidence(store,store.dataDir); const prefix = await readFile(path); const last = store.listEvidence().at(-1)!.id;
    store.addEvent('evidence-task','fixture-note',{ message: 'Multibyte evidence 漢字' }); const pending = Buffer.from(JSON.stringify(store.listEvidence(last)[0])+'\n');
    const unicode = pending.indexOf(Buffer.from('漢')); await appendFile(path,pending.subarray(0,unicode+1));
    expect((await flushEvidence(store,store.dataDir)).lastError).toBeNull(); expect(await readFile(path)).toEqual(Buffer.concat([prefix,pending]));
  });
  it('verifies large multiline JSON strings with bounded chunk reads', async () => {
    store.addEvent('evidence-task','large-fixture',{ text: '漢字\n'.repeat(30000) }); const wanted = expected();
    expect(Buffer.byteLength(wanted)).toBeGreaterThan(64*1024); expect((await flushEvidence(store,store.dataDir)).lastError).toBeNull(); expect(await readFile(path,'utf8')).toBe(wanted);
  });
  it('rejects tampered complete lines and extra complete records without rewriting them', async () => {
    await flushEvidence(store,store.dataDir); const wanted = await readFile(path,'utf8'); const tampered = wanted.replace('settings-initialized','settings-tampered'); await writeFile(path,tampered);
    store.addEvent('evidence-task','new-event',{}); const counts = store.evidenceCounts(); expect((await flushEvidence(store,store.dataDir)).lastError).toMatch(/SQLite prefix/); expect(await readFile(path,'utf8')).toBe(tampered); expect(store.evidenceCounts()).toEqual(counts);
    await writeFile(path,wanted+'{}\n'); expect((await flushEvidence(store,store.dataDir)).lastError).toMatch(/SQLite prefix/); expect(await readFile(path,'utf8')).toBe(wanted+'{}\n');
  });
  it('fails closed when an acknowledged file or complete prefix disappears', async () => {
    await flushEvidence(store,store.dataDir); const wanted = await readFile(path); await truncate(path,wanted.length-3);
    const incomplete = await readFile(path); expect((await flushEvidence(store,store.dataDir)).lastError).toMatch(/Acknowledged evidence prefix/); expect(await readFile(path)).toEqual(incomplete);
    await rm(path); expect((await flushEvidence(store,store.dataDir)).lastError).toMatch(/Acknowledged evidence is missing/); await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('fails safely on oversized unterminated lines without truncating existing bytes', async () => {
    const oversized = Buffer.alloc(16*1024*1024+1,120); await writeFile(path,oversized,{ mode: 0o600 });
    const before = store.evidenceCounts(); expect((await flushEvidence(store,store.dataDir)).lastError).toMatch(/bounded delivery size/);
    expect(statSync(path).size).toBe(oversized.length); expect(store.evidenceCounts()).toEqual(before);
  });
  it('serializes concurrent flushes and delivers intervening committed mutations', async () => {
    const first = flushEvidence(store,store.dataDir); store.addEvent('evidence-task','between-flushes',{ observed: true }); const second = flushEvidence(store,store.dataDir);
    expect((await first).lastError).toBeNull(); expect((await second).lastError).toBeNull(); expect(await readFile(path,'utf8')).toBe(expected()); expect(store.evidenceCounts().pending).toBe(0);
  });
  it('rejects symlink and hardlink evidence files while leaving their targets intact', async () => {
    const target = join(root,'target'); await writeFile(target,'do not overwrite',{ mode: 0o600 }); await symlink(target,path);
    expect((await flushEvidence(store,store.dataDir)).lastError).toMatch(/without links/); expect(await readFile(target,'utf8')).toBe('do not overwrite');
    await rm(path); await link(target,path); expect((await flushEvidence(store,store.dataDir)).lastError).toMatch(/without links/); expect(await readFile(target,'utf8')).toBe('do not overwrite');
  });
  it('rejects unsafe parents, mismatched data directories and world-readable evidence', async () => {
    await writeFile(path,'',{ mode: 0o644 }); expect((await flushEvidence(store,store.dataDir)).lastError).toMatch(/private regular file/);
    await chmod(path,0o600); await chmod(store.dataDir,0o755); expect((await flushEvidence(store,store.dataDir)).lastError).toMatch(/directory must be private/); await chmod(store.dataDir,0o700);
    expect((await flushEvidence(store,root)).lastError).toMatch(/match the authoritative queue/);
    const alias = join(root,'alias'); await symlink(store.dataDir,alias); expect((await flushEvidence(store,alias)).lastError).toMatch(/directory must be private/);
  });
  it('exposes safe errors, retains pending SQLite records and succeeds on retry', async () => {
    await writeFile(path,'not a complete evidence line\n',{ mode: 0o600 }); const before = store.evidenceCounts();
    const status = await flushEvidence(store,store.dataDir); expect(status.lastError).not.toContain(root); expect(store.evidenceCounts()).toEqual(before);
    await rm(path); expect((await flushEvidence(store,store.dataDir)).pending).toBe(0); expect(await readFile(path,'utf8')).toBe(expected());
  });
});
