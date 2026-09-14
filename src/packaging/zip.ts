import { appError } from "../errors.js";

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeEntryName(value: string): string {
  const name = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = name.split("/");
  if (
    !name ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    /^[A-Za-z]:/u.test(name) ||
    name.includes("\0")
  ) {
    throw appError("UNSAFE_ZIP_ENTRY", "packaging", "ZIP entry path is unsafe");
  }
  return name;
}

function u16(value: number): Buffer {
  const output = Buffer.allocUnsafe(2);
  output.writeUInt16LE(value, 0);
  return output;
}

function u32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32LE(value >>> 0, 0);
  return output;
}

export function createZip(entries: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
  if (entries.length > 65_535)
    throw appError(
      "ZIP_ENTRY_LIMIT",
      "packaging",
      "ZIP64 is not supported; archive has too many entries",
    );
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(safeEntryName(entry.name), "utf8");
    const bytes = Buffer.from(entry.bytes);
    const checksum = crc32(bytes);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0x0021),
      u32(checksum),
      u32(bytes.length),
      u32(bytes.length),
      u16(name.length),
      u16(0),
      name,
      bytes,
    ]);
    localParts.push(local);
    centralParts.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0x0021),
        u32(checksum),
        u32(bytes.length),
        u32(bytes.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...localParts, central, end]);
}

export { crc32, safeEntryName };
