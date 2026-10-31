import { closeSync, copyFileSync, chmodSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, appendFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";

/**
 * Antigravity's ACP server takes a client prompt only as an appended section
 * (`_meta.antigravity.systemPrompt.append`) behind its own ~1.4k-word harness
 * prompt. Its SDK has a full replacement (`CustomSystemInstructions`) that ACP
 * cannot reach. Native Droid sends its prompt to the model alone, so the bridge
 * runs a patched copy of the server: an appended prompt that starts with
 * REPLACE_MARKER becomes CustomSystemInstructions; anything else behaves as
 * before. The original file is never touched.
 *
 * The server is an ELF stub with a zip appended, run in place: its native
 * libraries are loaded from fixed offsets inside the file. So the patch moves
 * nothing. It writes the edited sources where the central directory was, then
 * a new central directory without the old entries (and without their compiled
 * __pycache__ copies, so the edited source is what gets imported). The zip is
 * the ELF section `.par_data`, whose recorded size tells the loader where the
 * end record is, so that size is updated too. If an anchor
 * is missing (a new Antigravity version changed the code), no copy is made and
 * the bridge keeps the append mode.
 */
export const REPLACE_MARKER = "<<factory-cc:replace-system-prompt>>";
const PATCH_VERSION = 1;

interface SourcePatch { file: string; anchor: string; replacement: string }

const PATCHES: SourcePatch[] = [
  {
    file: "google3/cloud/developer_experience/antigravity_extensions/acp_server/proxy_agent_config.py",
    anchor: "    if isinstance(self.system_instructions, str):\n      si = sdk_types_module.TemplatedSystemInstructions(",
    replacement: `    if isinstance(self.system_instructions, str) and self.system_instructions.startswith(${JSON.stringify(REPLACE_MARKER)}):
      si = sdk_types_module.CustomSystemInstructions(text=self.system_instructions[${REPLACE_MARKER.length}:].strip())
    elif isinstance(self.system_instructions, str):
      si = sdk_types_module.TemplatedSystemInstructions(`,
  },
  {
    file: "google3/third_party/py/google/antigravity/connections/local/local_connection_config.py",
    anchor: "    if isinstance(self.system_instructions, str):\n      return types.TemplatedSystemInstructions(",
    replacement: `    if isinstance(self.system_instructions, str) and self.system_instructions.startswith(${JSON.stringify(REPLACE_MARKER)}):
      return types.CustomSystemInstructions(text=self.system_instructions[${REPLACE_MARKER.length}:].strip())
    if isinstance(self.system_instructions, str):
      return types.TemplatedSystemInstructions(`,
  },
];

interface CentralRecord { name: string; raw: Buffer; method: number; compressedSize: number; offset: number }

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new Error("unexpected end of file");
    done += read;
  }
  return buffer;
}

function readZip(fd: number, size: number): { base: number; cdOffset: number; records: CentralRecord[] } {
  const tailLength = Math.min(size, 65_557);
  const tail = readAt(fd, size - tailLength, tailLength);
  const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) throw new Error("no end of central directory");
  if (tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07])) >= 0) throw new Error("zip64 archives are not supported");
  const eocd = size - tailLength + at;
  const entries = tail.readUInt16LE(at + 10), cdSize = tail.readUInt32LE(at + 12), cdOffset = tail.readUInt32LE(at + 16);
  // Offsets are relative to where the zip starts, after the executable stub.
  const base = eocd - cdSize - cdOffset;
  const cd = readAt(fd, base + cdOffset, cdSize);
  const records: CentralRecord[] = [];
  for (let pos = 0, index = 0; index < entries; index++) {
    if (cd.readUInt32LE(pos) !== 0x02014b50) throw new Error("bad central directory record");
    const nameLength = cd.readUInt16LE(pos + 28), extraLength = cd.readUInt16LE(pos + 30), commentLength = cd.readUInt16LE(pos + 32);
    const length = 46 + nameLength + extraLength + commentLength;
    records.push({
      name: cd.toString("utf8", pos + 46, pos + 46 + nameLength), raw: cd.subarray(pos, pos + length),
      method: cd.readUInt16LE(pos + 10), compressedSize: cd.readUInt32LE(pos + 20), offset: cd.readUInt32LE(pos + 42),
    });
    pos += length;
  }
  return { base, cdOffset, records };
}

function entryData(fd: number, base: number, record: CentralRecord): Buffer {
  const header = readAt(fd, base + record.offset, 30);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${record.name}`);
  return readAt(fd, base + record.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), record.compressedSize);
}

/** The edited sources, or undefined when this server version does not match the patch. */
function patchedSources(fd: number, base: number, records: CentralRecord[]): Map<string, Buffer> | undefined {
  const out = new Map<string, Buffer>();
  for (const patch of PATCHES) {
    const record = records.find((item) => item.name === patch.file);
    if (!record || record.method !== 0) return undefined;
    const source = entryData(fd, base, record).toString("utf8");
    if (source.split(patch.anchor).length !== 2) return undefined;
    out.set(patch.file, Buffer.from(source.replace(patch.anchor, patch.replacement), "utf8"));
  }
  return out;
}

const compiledCopy = (file: string): string => {
  const slash = file.lastIndexOf("/");
  return `${file.slice(0, slash)}/__pycache__/${file.slice(slash + 1, -3)}.`;
};

/**
 * Set the size of the ELF section that holds the zip (it starts at `base` and
 * was `oldLength` bytes). The loader finds the end record from it.
 */
function resizeZipSection(path: string, base: number, oldLength: number, newLength: number): void {
  const fd = openSync(path, "r+");
  try {
    const header = readAt(fd, 0, 64);
    if (header.readUInt32BE(0) !== 0x7f454c46) return; // not ELF: the zip is found from the file end
    if (header[4] !== 2 || header[5] !== 1) throw new Error("only 64-bit little-endian ELF is supported");
    const tableOffset = Number(header.readBigUInt64LE(0x28)), entrySize = header.readUInt16LE(0x3a), count = header.readUInt16LE(0x3c);
    for (let index = 0; index < count; index++) {
      const entry = readAt(fd, tableOffset + index * entrySize, entrySize);
      if (Number(entry.readBigUInt64LE(24)) === base && Number(entry.readBigUInt64LE(32)) === oldLength) {
        const size = Buffer.alloc(8);
        size.writeBigUInt64LE(BigInt(newLength));
        writeSync(fd, size, 0, 8, tableOffset + index * entrySize + 32);
        return;
      }
    }
    throw new Error("no ELF section holds the zip");
  } finally {
    closeSync(fd);
  }
}

/** Write a patched copy of `source` to `target`. Returns false (writing nothing) if the patch does not apply. */
export function writePatchedAntigravity(source: string, target: string): boolean {
  const fd = openSync(source, "r");
  let sources: Map<string, Buffer> | undefined, base = 0, cdOffset = 0, records: CentralRecord[] = [], size = 0;
  try {
    size = fstatSync(fd).size;
    ({ base, cdOffset, records } = readZip(fd, size));
    sources = patchedSources(fd, base, records);
  } finally {
    closeSync(fd);
  }
  if (!sources) return false;
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    copyFileSync(source, temporary);
    truncateSync(temporary, base + cdOffset);
    const locals: Buffer[] = [];
    const replaced = new Map<string, Buffer>();
    let offset = cdOffset;
    for (const [name, data] of sources) {
      const original = records.find((item) => item.name === name)!;
      const nameBytes = Buffer.from(name, "utf8"), crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(original.raw.readUInt16LE(6), 4);   // version needed
      local.writeUInt16LE(0, 6);                             // flags: sizes are in this header
      local.writeUInt16LE(0, 8);                             // stored
      local.writeUInt16LE(original.raw.readUInt16LE(12), 10); // time
      local.writeUInt16LE(original.raw.readUInt16LE(14), 12); // date
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      local.writeUInt16LE(0, 28);
      locals.push(local, nameBytes, data);
      const central = Buffer.from(original.raw);
      central.writeUInt16LE(central.readUInt16LE(8) & ~0x0008, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt32LE(offset, 42);
      replaced.set(name, central);
      offset += 30 + nameBytes.length + data.length;
    }
    const dropped = [...sources.keys()].map(compiledCopy);
    const kept = records.flatMap((record) => {
      if (replaced.has(record.name)) return [replaced.get(record.name)!];
      if (dropped.some((prefix) => record.name.startsWith(prefix) && record.name.endsWith(".pyc"))) return [];
      return [record.raw];
    });
    const cd = Buffer.concat(kept);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(kept.length, 8);
    eocd.writeUInt16LE(kept.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    appendFileSync(temporary, Buffer.concat([...locals, cd, eocd]));
    resizeZipSection(temporary, base, size - base, offset + cd.length + eocd.length);
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
    return true;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** `original` is the unmodified server, the fallback when the patched copy fails. */
export interface AntigravityExecutable { executable: string; replacesPrompt: boolean; original: string }

/**
 * The patched copy next to `source` (made once per Antigravity version), or the
 * original with replacesPrompt false when the patch does not apply or fails.
 */
export function droidAntigravity(source: string, onError?: (error: unknown) => void): AntigravityExecutable {
  try {
    const real = realpathSync(source);
    const target = join(dirname(real), "agy_acp_server.droid.par");
    const stampPath = `${target}.json`;
    const { size, mtimeMs } = statSync(real);
    const stamp = JSON.stringify({ patch: PATCH_VERSION, size, mtimeMs });
    if (existsSync(target) && existsSync(stampPath) && readFileSync(stampPath, "utf8") === stamp) {
      return { executable: target, replacesPrompt: true, original: source };
    }
    if (!writePatchedAntigravity(real, target)) {
      onError?.(new Error("Antigravity patch anchors not found; using the appended prompt"));
      return { executable: source, replacesPrompt: false, original: source };
    }
    writeFileSync(stampPath, stamp, { mode: 0o600 });
    return { executable: target, replacesPrompt: true, original: source };
  } catch (error) {
    onError?.(error);
    return { executable: source, replacesPrompt: false, original: source };
  }
}
