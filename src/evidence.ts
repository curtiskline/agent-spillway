import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EvidenceRecord, EvidenceStatus } from './contracts.js';
import { Store } from './store.js';

const LINE_LIMIT = 16 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const writers = new Map<string, Promise<EvidenceStatus>>();
class DeliveryError extends Error {}
const privateOwner = (info: Stats): boolean => (info.mode & 0o077) === 0 && (!process.getuid || info.uid === process.getuid());
const sameFile = (a: Stats,b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
function serialized(record: EvidenceRecord): Buffer {
  const line = Buffer.from(JSON.stringify(record) + '\n','utf8');
  if (line.length > LINE_LIMIT) throw new DeliveryError('Evidence snapshot exceeds the bounded delivery size; SQLite retains it.');
  return line;
}

async function drain(store: Store,dataDir: string): Promise<EvidenceStatus> {
  let file: FileHandle | undefined;
  let directory: FileHandle | undefined;
  try {
    const supplied = await lstat(dataDir);
    if (!supplied.isDirectory() || supplied.isSymbolicLink() || !privateOwner(supplied)) throw new DeliveryError('Evidence directory must be private and owned by this user.');
    const canonical = await realpath(dataDir);
    if (canonical !== store.dataDir) throw new DeliveryError('Evidence directory must match the authoritative queue.');
    directory = await open(canonical,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const dirInfo = await directory.stat();
    if (!sameFile(supplied,dirInfo) || !privateOwner(dirInfo)) throw new DeliveryError('Evidence directory changed during delivery.');
    const path = join(canonical,'evidence.jsonl');
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !privateOwner(info)) throw new DeliveryError('Evidence file must be a private regular file without links.');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (store.evidenceCounts().delivered) throw new DeliveryError('Acknowledged evidence is missing; SQLite records remain intact.');
    }
    file = await open(path,constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,0o600);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || !privateOwner(info) || !sameFile(await lstat(path),info)) throw new DeliveryError('Evidence file must be a private regular file without links.');
    const originalSize = info.size;
    const expected: EvidenceRecord[] = [];
    let afterId = 0;
    const next = (): EvidenceRecord | undefined => {
      if (!expected.length) expected.push(...store.listEvidence(afterId,1));
      const record = expected.shift();
      if (record) afterId = record.id;
      return record;
    };
    const chunk = Buffer.alloc(CHUNK_SIZE);
    let position = 0;
    let completeBytes = 0;
    let completeLines = 0;
    let tail: Buffer[] = [];
    let tailLength = 0;
    let lastVerifiedId = 0;
    while (position < originalSize) {
      const read = await file.read(chunk,0,Math.min(CHUNK_SIZE,originalSize-position),position);
      if (!read.bytesRead) throw new DeliveryError('Evidence file changed while its prefix was being verified.');
      position += read.bytesRead;
      let fragment = chunk.subarray(0,read.bytesRead);
      while (fragment.length) {
        const newline = fragment.indexOf(10);
        const bytes = newline < 0 ? fragment : fragment.subarray(0,newline+1);
        if (tailLength + bytes.length > LINE_LIMIT) throw new DeliveryError('Evidence line exceeds the bounded delivery size.');
        tail.push(Buffer.from(bytes)); tailLength += bytes.length;
        if (newline < 0) break;
        const record = next();
        if (!record || !Buffer.concat(tail,tailLength).equals(serialized(record))) throw new DeliveryError('Evidence file does not match the authoritative SQLite prefix.');
        lastVerifiedId = record.id; completeLines++; completeBytes += tailLength;
        tail = []; tailLength = 0; fragment = fragment.subarray(newline+1);
      }
    }
    if (completeLines < store.evidenceCounts().delivered) throw new DeliveryError('Acknowledged evidence prefix is missing; SQLite records remain intact.');
    if ((await file.stat()).size !== originalSize) throw new DeliveryError('Evidence file changed while its prefix was being verified.');
    // A partial final line has never been acknowledged. Recover only that tail.
    if (tailLength) await file.truncate(completeBytes);
    let writePosition = completeBytes;
    for (let record = next(); record; record = next()) {
      const line = serialized(record);
      let offset = 0;
      while (offset < line.length) {
        const written = await file.write(line,offset,line.length-offset,writePosition+offset);
        if (!written.bytesWritten) throw new DeliveryError('Evidence append made no progress; SQLite records remain pending.');
        offset += written.bytesWritten;
      }
      writePosition += line.length; lastVerifiedId = record.id;
    }
    await file.sync();
    // Persist the directory entry even after an earlier interrupted creation.
    await directory.sync();
    const final = await lstat(path);
    if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1 || !privateOwner(final) || !sameFile(final,info) || final.size !== writePosition || !sameFile(await lstat(canonical),dirInfo)) throw new DeliveryError('Evidence file or directory changed before acknowledgement.');
    if (lastVerifiedId) store.acknowledgeEvidence(lastVerifiedId);
    return { ...store.evidenceCounts(),lastError: null };
  } catch (error: unknown) {
    return { ...store.evidenceCounts(),lastError: error instanceof DeliveryError ? error.message : 'Evidence delivery failed; committed SQLite records remain intact.' };
  } finally {
    await file?.close().catch(() => {}); await directory?.close().catch(() => {});
  }
}

/** Single in-process writer per canonical directory; SQLite remains authoritative. */
export async function flushEvidence(store: Store,dataDir: string): Promise<EvidenceStatus> {
  const key = await realpath(dataDir).catch(() => resolve(dataDir));
  const previous = writers.get(key);
  const current = (previous ?? Promise.resolve()).then(() => drain(store,dataDir));
  writers.set(key,current);
  try { return await current; } finally { if (writers.get(key) === current) writers.delete(key); }
}
