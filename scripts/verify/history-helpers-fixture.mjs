// Synthetic header-only PE fixture for packaging tests. Never executed.
export function syntheticHistoryHelper({ pe32 = false } = {}) {
  const bytes = Buffer.alloc(1024);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(128, 60);
  bytes.write("PE\0\0", 128, "ascii");
  bytes.writeUInt16LE(pe32 ? 0x14c : 0x8664, 132);
  bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(pe32 ? 224 : 240, 148);
  bytes.writeUInt16LE(0x0022, 150);
  bytes.writeUInt16LE(pe32 ? 0x10b : 0x20b, 152);
  return bytes;
}
