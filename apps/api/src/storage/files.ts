import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface SavedFile {
  storageKey: string;   // file name inside UPLOAD_DIR (random, never the user's file name)
  sizeBytes: number;
  sha256: string;
  isPdf: boolean;       // true if the file starts with the PDF magic bytes "%PDF-"
}

const PDF_MAGIC = Buffer.from('%PDF-');

// Streams an upload to disk in ONE pass while hashing it and checking its first bytes.
// The whole file is never held in memory, so a 25 MB upload costs ~64 KB of RAM.
export async function saveUpload(source: Readable, uploadDir: string): Promise<SavedFile> {
  await mkdir(uploadDir, { recursive: true });
  const storageKey = `${randomUUID()}.pdf`;
  const tmpPath = join(uploadDir, `${storageKey}.part`);

  const hash = createHash('sha256');
  let sizeBytes = 0;
  let head = Buffer.alloc(0);

  // A pass-through stream that "taps" each chunk on its way to the disk.
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      if (head.length < PDF_MAGIC.length) head = Buffer.concat([head, chunk]).subarray(0, PDF_MAGIC.length);
      done(null, chunk);
    },
  });

  try {
    await pipeline(source, tap, createWriteStream(tmpPath));
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }

  // Written as ".part" first and renamed only when complete,
  // so a half-written file is never mistaken for a finished upload.
  await rename(tmpPath, join(uploadDir, storageKey));
  return { storageKey, sizeBytes, sha256: hash.digest('hex'), isPdf: head.equals(PDF_MAGIC) };
}

export const filePath = (uploadDir: string, storageKey: string) => join(uploadDir, storageKey);

export async function deleteFile(uploadDir: string, storageKey: string): Promise<void> {
  await rm(join(uploadDir, storageKey), { force: true });
}
