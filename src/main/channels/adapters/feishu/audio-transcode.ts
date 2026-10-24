import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { detectMpvBinary } from "../../../audio/mpv-binary";

export type FeishuAudioTranscodeDeps = {
  runMpv?: (executable: string, args: string[]) => Promise<void>;
  resolveMpvBinary?: () => string;
};
function executeEncoder(binary: string, arguments_: string[]): Promise<void> {
  return new Promise((accept, fail) => {
    const process = spawn(binary, arguments_, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let diagnostic = "";
    process.stderr.on("data", (bytes: Buffer) => { if (diagnostic.length < 16_000) diagnostic += bytes.toString("utf8"); });
    process.once("error", fail);
    process.once("close", (exitStatus) => {
      if (exitStatus === 0) accept();
      else fail(new Error(`mpv Opus 转码失败（exit=${exitStatus}）${diagnostic.trim() ? `: ${diagnostic.trim()}` : ""}`));
    });
  });
}

export async function transcodeAudioFileToFeishuOpus(inputPath: string, deps: FeishuAudioTranscodeDeps = {}): Promise<string> {
  const destination = path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}-${randomUUID()}.opus`);
  const binary = (deps.resolveMpvBinary ?? detectMpvBinary)();
  if (!binary) throw new Error("未找到可用的 mpv，无法将音频转码为飞书 Opus 格式");
  const arguments_ = ["--no-config", "--no-video", "--really-quiet", `--o=${destination}`, "--of=opus", "--oac=libopus", "--audio-channels=mono", "--audio-samplerate=48000", inputPath];
  try {
    await (deps.runMpv ?? executeEncoder)(binary, arguments_);
    const encoded = await fs.promises.readFile(destination);
    if (encoded.length < 4 || encoded.subarray(0, 4).toString("ascii") !== "OggS") throw new Error("mpv 返回的文件不是有效的 Ogg Opus 音频");
    return destination;
  } catch (failure) {
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw failure;
  }
}
