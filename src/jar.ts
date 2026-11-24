// Minimal jar (zip) reader: enough to pull mod metadata and the class file version
// out of a mod jar without any third-party dependency.
import * as zlib from 'zlib';
import { detectLoader } from './minecraft';

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function listEntries(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('not a zip/jar file');
  }
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error('corrupt zip central directory');
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      localHeaderOffset: buf.readUInt32LE(p + 42),
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const lh = e.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== LOC_SIG) {
    throw new Error(`corrupt zip entry ${e.name}`);
  }
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) {
    return data;
  }
  if (e.method === 8) {
    return zlib.inflateRawSync(data);
  }
  throw new Error(`unsupported compression method ${e.method} in ${e.name}`);
}

export interface JarInfo {
  /** Human readable mod name from fabric.mod.json / mods.toml. */
  modName?: string;
  modId?: string;
  /** Java release the classes were compiled for (8, 17, 21, ...). */
  javaVersion?: number;
  /** Loader worked out from the metadata files in the jar. */
  loader?: string;
}

function tomlString(toml: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\n]*)["']`, 'm').exec(toml);
  return m ? m[1] : undefined;
}

export function readJarInfo(buf: Buffer): JarInfo {
  const entries = listEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const info: JarInfo = { loader: detectLoader(byName.keys()) };

  const fabric = byName.get('fabric.mod.json') ?? byName.get('quilt.mod.json');
  if (fabric) {
    try {
      const json = JSON.parse(readEntry(buf, fabric).toString('utf8'));
      const meta = json.quilt_loader ? { ...json.quilt_loader, ...(json.quilt_loader.metadata ?? {}) } : json;
      info.modName = typeof meta.name === 'string' ? meta.name : undefined;
      info.modId = typeof meta.id === 'string' ? meta.id : undefined;
    } catch {
      // Malformed metadata is not fatal: the file name still says enough to upload.
    }
  }
  const toml = byName.get('META-INF/neoforge.mods.toml') ?? byName.get('META-INF/mods.toml');
  if (toml && !info.modName) {
    const text = readEntry(buf, toml).toString('utf8');
    info.modName = tomlString(text, 'displayName');
    info.modId = tomlString(text, 'modId');
  }

  // Class file major version = Java release + 44. Look at a few classes outside
  // META-INF (multi-release jars keep newer variants there) and take the highest.
  let major = 0;
  let looked = 0;
  for (const e of entries) {
    if (looked >= 8) {
      break;
    }
    if (!e.name.endsWith('.class') || e.name.startsWith('META-INF/')) {
      continue;
    }
    const cls = readEntry(buf, e);
    looked++;
    if (cls.length >= 8 && cls.readUInt32BE(0) === 0xcafebabe) {
      major = Math.max(major, cls.readUInt16BE(6));
    }
  }
  if (major >= 45) {
    info.javaVersion = major - 44;
  }
  return info;
}
