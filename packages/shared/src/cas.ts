/**
 * Minimal content-addressed store: <dataDir>/objects/<aa>/<full-sha256>.
 *
 * Publishing is atomic via write-temp + hardlink: readers never observe a
 * torn object, and concurrent writers of identical content converge on a
 * single stored copy (first hardlink wins, losers observe EEXIST and verify
 * the existing entry's size).
 */
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";

const HASH_RE = /^[0-9a-f]{64}$/;
const TEXT_ENCODER = new TextEncoder();

function asBytes(content: Uint8Array | string): Uint8Array<ArrayBuffer> {
  if (typeof content === "string") return TEXT_ENCODER.encode(content);
  // WebCrypto's BufferSource rejects SharedArrayBuffer-backed views; protocol
  // callers hand us ordinary byte arrays, so pass through with the narrowed view.
  return content as Uint8Array<ArrayBuffer>;
}

/** SHA-256 of the content as plain lowercase hex (64 chars). */
export async function sha256Hex(content: Uint8Array | string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", asBytes(content));
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function assertValidHash(hash: string): void {
  if (!HASH_RE.test(hash)) {
    throw new Error(
      `cas: invalid object hash ${JSON.stringify(hash)} — expected 64 lowercase hex chars`,
    );
  }
}

/** Bucketed filesystem path for an object: <dataDir>/objects/<hash[0:2]>/<hash>. */
export function objectPath(dataDir: string, hash: string): string {
  assertValidHash(hash);
  return `${dataDir}/objects/${hash.slice(0, 2)}/${hash}`;
}

export interface WriteObjectResult {
  hash: string;
  size: number;
  /** true when the object was already stored (dedup hit). */
  existed: boolean;
}

async function cleanTmp(tmpPath: string): Promise<void> {
  await rm(tmpPath, { force: true }).catch(() => {});
}

export async function writeObject(
  dataDir: string,
  content: Uint8Array | string,
): Promise<WriteObjectResult> {
  const bytes = asBytes(content);
  const hash = await sha256Hex(bytes);
  const path = objectPath(dataDir, hash);
  const dir = path.slice(0, path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });

  // Unique temp name in the target bucket: full write first, then publish
  // with an exclusive hardlink. Half-written data therefore never appears
  // under the object's real path.
  const tmp = `${dir}/.tmp-${hash}-${crypto.randomUUID()}`;
  try {
    await writeFile(tmp, bytes);
    try {
      await link(tmp, path);
      return { hash, size: bytes.byteLength, existed: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        const existing = await stat(path);
        if (existing.size !== bytes.byteLength) {
          throw new Error(
            `cas: storage corruption at ${path}: existing object has size ${existing.size}, ` +
              `expected ${bytes.byteLength} for hash ${hash} (E_INTERNAL)`,
          );
        }
        return { hash, size: bytes.byteLength, existed: true };
      }
      throw err;
    }
  } finally {
    await cleanTmp(tmp);
  }
}

/** Read an object; null when absent. Corrupted content throws (never returns silently). */
export async function readObject(dataDir: string, hash: string): Promise<Uint8Array | null> {
  const path = objectPath(dataDir, hash);

  let info: Stats;
  try {
    info = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }

  const bytes = await readFile(path);
  if (bytes.byteLength !== info.size) {
    throw new Error(`cas: storage corruption at ${path}: file changed between stat and read (E_INTERNAL)`);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== hash) {
    throw new Error(
      `cas: storage corruption at ${path}: content hashes to ${actual}, expected ${hash} (E_INTERNAL)`,
    );
  }
  return bytes;
}
