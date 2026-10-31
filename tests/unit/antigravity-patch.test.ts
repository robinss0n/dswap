import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { REPLACE_MARKER, droidAntigravity, writePatchedAntigravity } from "../../src/upstream/antigravity-patch.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

const PROXY = "google3/cloud/developer_experience/antigravity_extensions/acp_server/proxy_agent_config.py";
const LOCAL = "google3/third_party/py/google/antigravity/connections/local/local_connection_config.py";
const proxySource = "  def create_strategy(self):\n    if isinstance(self.system_instructions, str):\n      si = sdk_types_module.TemplatedSystemInstructions(\n          sections=[])\n";
const localSource = "  def _get_system_instructions(self):\n    if isinstance(self.system_instructions, str):\n      return types.TemplatedSystemInstructions(\n          sections=[])\n";

/** A minimal ELF64 header whose section table has one entry: the zip, as in a Google .par. */
function elfStub(zipOffset: number, zipLength: number): Buffer {
  const stub = Buffer.alloc(zipOffset);
  stub.writeUInt32BE(0x7f454c46, 0);
  stub[4] = 2; stub[5] = 1;
  stub.writeBigUInt64LE(64n, 0x28);  // section table right after the header
  stub.writeUInt16LE(64, 0x3a);      // entry size
  stub.writeUInt16LE(1, 0x3c);       // one section
  stub.writeBigUInt64LE(BigInt(zipOffset), 64 + 24);
  stub.writeBigUInt64LE(BigInt(zipLength), 64 + 32);
  return stub;
}

/** A stored (uncompressed) zip, offsets relative to its own start. */
function storedZip(files: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text), nameBytes = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** name -> content of every entry, read the way the loader does: from the ELF section's end. */
function readEntries(file: Buffer): Map<string, string> {
  const zipOffset = Number(file.readBigUInt64LE(64 + 24)), zipLength = Number(file.readBigUInt64LE(64 + 32));
  const end = zipOffset + zipLength - 22;
  expect(file.readUInt32LE(end)).toBe(0x06054b50);
  const count = file.readUInt16LE(end + 10), cdOffset = file.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let pos = zipOffset + cdOffset, index = 0; index < count; index++) {
    const nameLength = file.readUInt16LE(pos + 28), size = file.readUInt32LE(pos + 20), local = zipOffset + file.readUInt32LE(pos + 42);
    const name = file.toString("utf8", pos + 46, pos + 46 + nameLength);
    const data = file.subarray(local + 30 + file.readUInt16LE(local + 26), local + 30 + file.readUInt16LE(local + 26) + size);
    expect(crc32(data)).toBe(file.readUInt32LE(pos + 16));
    out.set(name, data.toString("utf8"));
    pos += 46 + nameLength + file.readUInt16LE(pos + 30) + file.readUInt16LE(pos + 32);
  }
  return out;
}

function fakePar(proxy = proxySource): { dir: string; path: string; original: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "agy-patch-"));
  dirs.push(dir);
  const zip = storedZip([
    ["google3/lib/native.so", "NATIVE-LIBRARY-BYTES"],
    [PROXY, proxy],
    ["google3/cloud/developer_experience/antigravity_extensions/acp_server/__pycache__/proxy_agent_config.cpython-314.pyc", "PYC"],
    [LOCAL, localSource],
    ["google3/third_party/py/google/antigravity/connections/local/__pycache__/local_connection_config.cpython-314.pyc", "PYC"],
  ]);
  const original = Buffer.concat([elfStub(4096, zip.length), zip]);
  const path = join(dir, "agy_acp_server.par");
  writeFileSync(path, original, { mode: 0o755 });
  return { dir, path, original };
}

describe("writePatchedAntigravity", () => {
  it("routes marked prompts to CustomSystemInstructions without moving any existing entry", () => {
    const { dir, path, original } = fakePar();
    const target = join(dir, "patched.par");
    expect(writePatchedAntigravity(path, target)).toBe(true);
    const patched = readFileSync(target);
    // Everything before the old central directory is byte-identical, so native
    // libraries loaded from fixed offsets are where they were.
    // The one exception is the ELF section's size field (8 bytes at 64 + 32).
    const oldEnd = 4096 + original.readUInt32LE(original.length - 6), sizeField = 64 + 32;
    expect(patched.subarray(0, sizeField).equals(original.subarray(0, sizeField))).toBe(true);
    expect(patched.subarray(sizeField + 8, oldEnd).equals(original.subarray(sizeField + 8, oldEnd))).toBe(true);
    expect(Number(patched.readBigUInt64LE(sizeField))).toBe(patched.length - 4096);
    const entries = readEntries(patched);
    expect(entries.get("google3/lib/native.so")).toBe("NATIVE-LIBRARY-BYTES");
    expect(entries.get(PROXY)).toContain(`startswith(${JSON.stringify(REPLACE_MARKER)})`);
    expect(entries.get(PROXY)).toContain("sdk_types_module.CustomSystemInstructions(");
    expect(entries.get(PROXY)).toContain("elif isinstance(self.system_instructions, str):");
    expect(entries.get(LOCAL)).toContain("types.CustomSystemInstructions(");
    // The compiled copies go, so the edited sources are what Python imports.
    expect([...entries.keys()].some((name) => name.endsWith(".pyc"))).toBe(false);
    expect(readFileSync(path).equals(original)).toBe(true);
  });

  it("writes nothing when the server's code no longer matches the patch", () => {
    const { dir, path } = fakePar("  def create_strategy(self):\n    return something_else()\n");
    const target = join(dir, "patched.par");
    expect(writePatchedAntigravity(path, target)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});

describe("droidAntigravity", () => {
  it("makes the patched copy once per server version and reuses it", () => {
    const { dir, path } = fakePar();
    const first = droidAntigravity(path);
    expect(first).toEqual({ executable: join(dir, "agy_acp_server.droid.par"), replacesPrompt: true, original: path });
    const stamp = readFileSync(`${first.executable}.json`, "utf8");
    expect(droidAntigravity(path)).toEqual(first);
    expect(readFileSync(`${first.executable}.json`, "utf8")).toBe(stamp);
  });

  it("keeps the original server when the patch does not apply", () => {
    const { path } = fakePar("nothing to patch\n");
    const errors: unknown[] = [];
    expect(droidAntigravity(path, (error) => errors.push(error))).toEqual({ executable: path, replacesPrompt: false, original: path });
    expect(errors).toHaveLength(1);
  });
});
