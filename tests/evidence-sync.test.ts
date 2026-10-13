import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startService,type ServiceHandle } from '../src/server.js';
import type { EvidenceStatus } from '../src/contracts.js';
import * as evidence from '../src/evidence.js';
import { fixture } from './helpers.js';

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise,resolve };
}

describe('explicit evidence sync drains its committed entry prefix', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let s: ServiceHandle;
  let release: () => void;
  beforeEach(async () => {
    f = await fixture(); s = await startService(f.config,{ once: true,adapter: f.adapter }); release = () => {};
    await s.controller.addTask(f.markdown('evidence-race'));
  });
  afterEach(async () => { release(); vi.restoreAllMocks(); await s.close(); await f.cleanup(); });
  async function request(path: string,method = 'GET') {
    return fetch(s.url+path,{ method,headers: { Authorization: `Bearer ${s.token}`,'Content-Type': 'application/json' },signal: AbortSignal.timeout(5000),...(method === 'POST' ? { body: '{}' } : {}) });
  }

  it.each(['GET','POST'])('%s waits beyond a coalesced older flush for records committed before explicit sync', async method => {
    const drain = evidence.flushEvidence;
    const firstDrained = deferred<EvidenceStatus>(); const gate = deferred<void>(); release = () => gate.resolve();
    let calls = 0;
    vi.spyOn(evidence,'flushEvidence').mockImplementation(async (store,dataDir) => {
      calls++;
      const status = await drain(store,dataDir);
      if (calls === 1) { firstDrained.resolve(status); await gate.promise; }
      return status;
    });
    // A routine response starts an automatic flush; withhold its old result only
    // after the real writer has fsynced and acknowledged that earlier prefix.
    expect((await request('/api/v1/status')).status).toBe(200);
    const old = await firstDrained.promise; expect(old.pending).toBe(0);
    s.store.addEvent('evidence-race','committed-during-older-sync',{ fixture: true });
    const counts = s.store.evidenceCounts.bind(s.store); const target = counts().pending+counts().delivered;
    expect(target).toBeGreaterThan(old.delivered);
    const entered = deferred<void>(); let armed = true;
    vi.spyOn(s.store,'evidenceCounts').mockImplementation(() => {
      const value = counts(); if (armed) { armed = false; entered.resolve(); } return value;
    });
    // Observe the server taking its entry watermark before releasing the old
    // promise. This proves it joins the stale in-flight flush, not a later one.
    let settled = false;
    const response = request(method === 'GET' ? '/api/v1/evidence' : '/api/v1/evidence/sync',method).then(value => { settled = true; return value; });
    await entered.promise; expect(settled).toBe(false); expect(calls).toBe(1);
    release();
    const res = await response; expect(res.status).toBe(200);
    const body = await res.json() as {data: EvidenceStatus};
    expect(body.data).toEqual({ pending: 0,delivered: target,lastError: null }); expect(calls).toBeGreaterThanOrEqual(2);
    expect(counts()).toEqual({ pending: 0,delivered: target });
    const expected = s.store.listEvidence(0,1000).map(record => JSON.stringify(record)+'\n').join('');
    expect(await readFile(join(f.data,'evidence.jsonl'),'utf8')).toBe(expected);
  });

  it('returns a visible delivery failure instead of spinning until new work is acknowledged', async () => {
    const drain = evidence.flushEvidence;
    let calls = 0;
    vi.spyOn(evidence,'flushEvidence').mockImplementation(async (store,dataDir) => {
      calls++;
      if (calls === 1) return { ...store.evidenceCounts(),lastError: 'Fixture evidence delivery failure; SQLite remains durable.' };
      return drain(store,dataDir);
    });
    const before = s.store.evidenceCounts(); expect(before.pending).toBeGreaterThan(0);
    const response = await request('/api/v1/evidence/sync','POST'); expect(response.status).toBe(200);
    const body = await response.json() as {data: EvidenceStatus};
    expect(body.data).toEqual({ ...before,lastError: 'Fixture evidence delivery failure; SQLite remains durable.' });
    // One explicit attempt and the normal response-triggered retry are enough.
    expect(calls).toBeLessThanOrEqual(2); expect(s.store.listEvidence()).toHaveLength(before.pending+before.delivered);
  });
},10000);
