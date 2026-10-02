import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";

// Uploaded files on local disk. Keys are built by the store from generated
// ids, never from a client's filename, so nothing a user sends can choose the
// path.
export function createFileStore(root: string) {
  const path = (key: string) => join(root, key);
  return {
    // Writes the file, then runs `record` (the database insert). If recording
    // fails the file is removed, so there is never a row pointing at nothing
    // or a file that no row points at.
    storeThenRecord<T>(key: string, bytes: Uint8Array, record: (meta: { sha256: string; sizeBytes: number }) => T): T {
      const target = path(key);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(`${target}.partial`, bytes);
      renameSync(`${target}.partial`, target);
      try {
        return record({ sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength });
      } catch (e) {
        rmSync(target, { force: true });
        throw e;
      }
    },
    read(key: string): Buffer {
      return readFileSync(path(key));
    },
    // For serving large files (captures, source archives, template artifacts)
    // without reading them into memory.
    stream(key: string): { body: ReadableStream<Uint8Array>; size: number } {
      const p = path(key);
      return { body: Readable.toWeb(createReadStream(p)) as ReadableStream<Uint8Array>, size: statSync(p).size };
    },
    // Call after the row's deletion has committed: a leftover file is
    // harmless, a row without its file is not.
    remove(key: string): void {
      rmSync(path(key), { force: true, recursive: true });
    },
  };
}

export type FileStore = ReturnType<typeof createFileStore>;
