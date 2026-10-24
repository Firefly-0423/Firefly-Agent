import * as fs from "fs";
import { spawn } from "child_process";
import { fireflyEnvironment } from "../../../../shared/firefly-environment";

function estimateByFileSize(filename: string): number | undefined {
  try {
    const metadata = fs.statSync(filename);
    if (!metadata.isFile() || metadata.size <= 1024) return undefined;
    const seconds = metadata.size / 16000;
    return Math.max(500, Math.round(seconds * 1000));
  } catch { return undefined; }
}

function probeWithFfprobe(filename: string, binary: string): Promise<number | undefined> {
  return new Promise((accept) => {
    try {
      const child = spawn(binary, ["-v", "error", "-show_entries", "format=duration", "-of", "json", filename], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const deadline = setTimeout(() => { child.kill(); accept(undefined); }, 3000);
      child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString("utf8"); });
      child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString("utf8"); });
      child.on("error", () => { clearTimeout(deadline); accept(undefined); });
      child.on("close", () => {
        clearTimeout(deadline);
        try {
          const duration = JSON.parse(stdout)?.format?.duration;
          if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) accept(Math.round(duration * 1000));
          else if (typeof duration === "string") {
            const seconds = Number(duration);
            accept(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined);
          } else accept(undefined);
        } catch { accept(undefined); }
      });
    } catch { accept(undefined); }
  });
}

function parseMp3Duration(filename: string): number | undefined {
  try {
    const bytes = fs.readFileSync(filename);
    if (bytes.length < 4) return undefined;
    let start = 0;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      const tagLength = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
      start = 10 + tagLength;
    }
    while (start + 4 <= bytes.length) {
      if (bytes[start] === 0xff && (bytes[start + 1] & 0xe0) === 0xe0) break;
      start++;
    }
    if (start + 4 > bytes.length) return undefined;
    const bits = bytes.readUInt32BE(start);
    const version = (bits >> 19) & 0x3;
    const layer = (bits >> 17) & 0x3;
    const rateIndex = (bits >> 12) & 0xf;
    const frequencyIndex = (bits >> 10) & 0x3;
    const padded = (bits >> 9) & 0x1;
    if (version !== 3 || layer !== 1) return undefined;
    if (rateIndex === 0 || rateIndex === 15) return undefined;
    if (frequencyIndex === 3) return undefined;
    const kilobits = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0][rateIndex] ?? 0;
    const frequency = [44100, 48000, 32000, 0][frequencyIndex] ?? 0;
    if (kilobits <= 0 || frequency <= 0) return undefined;
    const frameLength = Math.floor((144 * kilobits * 1000) / frequency) + (padded ? 1 : 0);
    if (frameLength <= 0) return undefined;
    const payloadLength = bytes.length - start;
    const frames = payloadLength / frameLength;
    const seconds = frames * 1152 / frequency;
    return Math.round(seconds * 1000);
  } catch { return undefined; }
}

export async function getAudioDurationMs(filePath: string): Promise<number | undefined> {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  if (!fireflyEnvironment(process.env, "FIREFLY_SKIP_FFPROBE")) {
    for (const binary of ["ffprobe", "C:\\Users\\Public\\ffmpeg\\bin\\ffprobe.exe", "C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe"]) {
      try {
        const measured = await probeWithFfprobe(filePath, binary);
        if (measured) return measured;
      } catch { /* 继续尝试下一个探测位置。 */ }
    }
  }
  const measured = parseMp3Duration(filePath);
  if (measured) {
    console.log("[FeishuAudioDuration]", `mp3 header 解析: ${measured}ms`);
    return measured;
  }
  console.log("[FeishuAudioDuration]", `mp3 header 解析失败（可能不是 mp3）: ${filePath}`);
  const estimated = estimateByFileSize(filePath);
  if (estimated) {
    console.warn("[FeishuAudioDuration]", `估算时长: ${estimated}ms (建议安装 ffprobe 提高精度)`);
    return estimated;
  }
  console.warn("[FeishuAudioDuration]", `无法计算时长: ${filePath}`);
  return undefined;
}
