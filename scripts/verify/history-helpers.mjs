// Checks both required Windows PE artifacts; it never runs the helpers.
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const helperNames = ["firefly-history-read.exe", "firefly-history-presence.exe"];

export async function verifyHelper(helperPath) {
  const file = await open(helperPath, "r").catch(error => {
    if (error.code === "ENOENT") throw new Error(`History helper missing: ${helperPath}`, { cause: error });
    if (error.code === "EISDIR") throw new Error(`History helper is not a file: ${helperPath}`, { cause: error });
    throw error;
  });
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error(`History helper is not a file: ${helperPath}`);
    const invalid = () => new Error(`History helper is not a Windows PE executable: ${helperPath}`);
    const readHeader = async (offset, length) => {
      if (offset < 0 || offset + length > metadata.size) throw invalid();
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw invalid();
      return buffer;
    };

    const dos = await readHeader(0, 64);
    if (dos.toString("ascii", 0, 2) !== "MZ") throw invalid();
    const peOffset = dos.readUInt32LE(60);
    if (peOffset < 64) throw invalid();
    const pe = await readHeader(peOffset, 24);
    if (!pe.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) throw invalid();
    const machine = pe.readUInt16LE(4);
    const sections = pe.readUInt16LE(6);
    const optionalSize = pe.readUInt16LE(20);
    const characteristics = pe.readUInt16LE(22);
    if (![0x14c, 0x8664, 0xaa64].includes(machine)
      || sections === 0 || sections > 96
      || !(characteristics & 0x0002) || (characteristics & 0x2000)) throw invalid();
    const optional = await readHeader(peOffset + 24, 2);
    const magic = optional.readUInt16LE(0);
    if (magic !== (machine === 0x14c ? 0x10b : 0x20b)
      || optionalSize < (magic === 0x10b ? 96 : 112)
      || peOffset + 24 + optionalSize + sections * 40 > metadata.size) throw invalid();

    return { helperPath, size: metadata.size };
  } finally {
    await file.close();
  }
}

export async function verifyHistoryHelpers(directory = path.join(repoRoot, "native", "target", "release")) {
  const verified = [];
  for (const name of helperNames) verified.push(await verifyHelper(path.resolve(directory, name)));
  return verified;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  verifyHistoryHelpers(process.argv[2]).then(helpers => {
    for (const helper of helpers)
      console.log(`[history-helpers] verified ${helper.helperPath} (${helper.size} bytes)`);
  }).catch(error => {
    console.error(`[history-helpers] verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
