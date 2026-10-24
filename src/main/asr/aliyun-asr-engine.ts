// 阿里云实时语音识别适配层：经 WebSocket 连接 NLS 网关，控制指令走 JSON 文本帧，音频走二进制帧。
//
// 接口细节以阿里云智能语音交互的 WebSocket 开发文档为准。
// 建连前先用 AccessKey 换取临时 token，再把它放进网关地址的查询参数。
// 音频规格：PCM，16kHz 采样，16bit 位深，单声道。

import { WebSocket } from "ws";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { createAbortError, raceWithSignal } from "../abort-utils";

const LOG_PREFIX = "[AliyunASR]";
const NLS_GATEWAY = "wss://nls-gateway.cn-shanghai.aliyuncs.com/ws/v1";
const MAX_TRANSCRIPT_CHARS = 32_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
// 200ms of 16kHz / 16bit / mono audio
const AUDIO_CHUNK_BYTES = 6400;

/** 服务端下行帧的读取形状；各字段都可能缺省，读取时需要逐层判空 */
type ServerFrame = {
  payload?: { confidence?: number; time?: number; index?: number; result?: string };
  header?: { name?: string; task_id?: string; status_text?: string; status?: number };
};

/** 单次实时识别会话：负责建连、推流、收尾与取消 */
export class AliyunAsrStream {
  private ws: WebSocket | null = null;
  private stopped: boolean = false;
  private cancelled = false;
  private ready = false;
  private readonly tokenAbort = new AbortController();
  private startPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private stopPromise: Promise<string> | null = null;
  private resolveStop: ((text: string) => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;
  private failure: Error | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly finals: string[] = [];
  private transcriptChars = 0;
  private audioBuffer: Buffer = Buffer.alloc(0);
  private taskId: string = randomUUID().replace(/-/g, "");
  private appKey: string = "";

  constructor(
    private readonly handlePartial: (text: string) => void,
    private readonly handleFinal: (text: string) => void,
  ) {}

  /** 启动会话；重复调用返回同一个 Promise，避免重复建连 */
  start(appKey: string, accessKeyId: string, accessKeySecret: string, language: string): Promise<void> {
    if (this.stopped || this.cancelled) return Promise.reject(createAbortError());
    if (!this.startPromise) this.startPromise = this.connect(appKey, accessKeyId, accessKeySecret, language);
    return this.startPromise;
  }

  private async connect(appKey: string, accessKeyId: string, accessKeySecret: string, language: string): Promise<void> {
    this.appKey = appKey;
    try {
      const token = await raceWithSignal(this.getToken(accessKeyId, accessKeySecret), this.tokenAbort.signal);
      if (this.stopped || this.cancelled) throw createAbortError();
      const socket = new WebSocket(`${NLS_GATEWAY}?token=${encodeURIComponent(token)}`, { maxPayload: MAX_MESSAGE_BYTES });
      this.ws = socket;
      await new Promise<void>((resolve, reject) => {
        this.resolveReady = () => { this.resolveReady = null; this.rejectReady = null; resolve(); };
        this.rejectReady = (error) => { this.resolveReady = null; this.rejectReady = null; reject(error); };
        socket.on("open", () => {
          if (this.ws !== socket || this.stopped || this.cancelled) return;
          this.sendStartTranscription(appKey, language);
        });
        socket.on("message", (raw: Buffer) => {
          if (this.ws === socket && !this.cancelled) this.handleMessage(raw);
        });
        socket.on("error", (error) => {
          if (this.ws !== socket) return;
          this.fail(error);
        });
        socket.on("close", () => {
          if (this.ws !== socket) return;
          this.rejectReady?.(new Error("ASR connection closed before transcription started"));
          this.finishRecognition();
        });
      });
    } catch (err) {
      this.cancel();
      throw err;
    }
  }

  /** 发送开始识别指令（JSON 文本帧） */
  private sendStartTranscription(appKey: string, language: string): void {
    const langMap: Record<string, string> = { zh: "zh-CN", en: "en-US" };
    const payload = { format: "pcm", sample_rate: 16000, enable_intermediate_result: true, enable_punctuation_prediction: true, enable_inverse_text_normalization: true, max_sentence_silence: 800 };
    const command = this.buildCommand("StartTranscription", appKey, payload);
    try {
      this.ws?.send(JSON.stringify(command));
    } catch (err) {
      this.rejectReady?.(err instanceof Error ? err : new Error(String(err)));
      this.cancel();
    }
  }

  /** 组装一条控制指令：header 在前，有 payload 时追加在后 */
  private buildCommand(name: string, appKey: string, payload?: Record<string, unknown>): Record<string, unknown> {
    const header = { message_id: randomUUID().replace(/-/g, ""), task_id: this.taskId, namespace: "SpeechTranscriber", name, appkey: appKey };
    return payload === undefined ? { header } : { header, payload };
  }

  /** 推入一帧 PCM，凑满一个分片后再发往服务端 */
  sendAudio(pcmFrame: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready || this.stopped) return;
    this.audioBuffer = Buffer.concat([this.audioBuffer, pcmFrame]);
    while (this.audioBuffer.length >= AUDIO_CHUNK_BYTES) {
      const piece = this.audioBuffer.subarray(0, AUDIO_CHUNK_BYTES);
      this.audioBuffer = this.audioBuffer.subarray(AUDIO_CHUNK_BYTES);
      this.ws.send(piece, { binary: true });
    }
  }

  /** 收尾：先补发缓存中的残余音频，再发结束指令；2 秒内没有收到完成事件则强制结束 */
  stop(): Promise<string> {
    if (this.failure) return this.stopPromise ??= Promise.reject(this.failure);
    if (this.stopPromise) return this.stopPromise;
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.cancel();
      return this.stopPromise!;
    }
    this.stopped = true;
    this.stopPromise = new Promise<string>((resolve, reject) => { this.resolveStop = resolve; this.rejectStop = reject; });
    this.closeTimer = setTimeout(() => this.finishRecognition(), 2000);

    // 残余音频不足一个分片，也要一次性送出
    if (this.audioBuffer.length !== 0) {
      try { this.ws.send(this.audioBuffer, { binary: true }); } catch { /* ignore */ }
      this.audioBuffer = Buffer.alloc(0);
    }

    const command = this.buildCommand("StopTranscription", this.appKey);
    try { this.ws.send(JSON.stringify(command)); } catch { this.finishRecognition(); }
    return this.stopPromise;
  }

  /** Cancel never requests a final transcript or emits text after ownership is revoked. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stopped = true;
    this.ready = false;
    this.tokenAbort.abort();
    this.rejectReady?.(createAbortError());
    this.audioBuffer = Buffer.alloc(0);
    this.finals.length = 0;
    this.transcriptChars = 0;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.failure) this.rejectStop?.(this.failure);
    else this.resolveStop?.("");
    this.resolveStop = null;
    this.rejectStop = null;
    if (!this.failure) this.stopPromise ??= Promise.resolve("");
    const socket = this.ws;
    this.ws = null;
    if (socket) { try { socket.terminate(); } catch { /* already closed */ } }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.rejectReady?.(this.failure);
    this.cancel();
  }

  private finishRecognition(): void {
    this.stopped = true;
    this.ready = false;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    const text = this.cancelled ? "" : this.finals.join("");
    this.resolveStop?.(text);
    this.resolveStop = null;
    this.rejectStop = null;
    this.stopPromise ??= Promise.resolve(text);
    const socket = this.ws;
    this.ws = null;
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
  }

  /** 解析一帧下行消息，并按事件类型分发 */
  private handleMessage(raw: Buffer): void {
    try {
      const frame = JSON.parse(raw.toString()) as ServerFrame;
      const status = frame.header?.status;
      const eventName = frame.header?.name;

      if (status !== undefined && status !== 20000000) {
        this.fail(new Error(`ASR 错误: status=${status}`));
        return;
      }

      if (eventName === "TranscriptionResultChanged" || eventName === "SentenceEnd") {
        const text = frame.payload?.result;
        if (typeof text !== "string") {
          this.fail(new Error("ASR_INVALID_TRANSCRIPT"));
          return;
        }
        if (text.length > MAX_TRANSCRIPT_CHARS
            || (eventName === "SentenceEnd" && this.transcriptChars + text.length > MAX_TRANSCRIPT_CHARS)) {
          this.fail(new Error("ASR_TRANSCRIPT_LIMIT"));
          return;
        }
      }

      switch (eventName) {
        case "TranscriptionStarted":
          this.ready = true;
          this.resolveReady?.();
          break;
        case "TranscriptionResultChanged": {
          // 中间结果会被后续帧覆盖，只做回调，不做累计
          const partial = frame.payload?.result ?? "";
          if (partial) this.handlePartial(partial);
          break;
        }
        case "SentenceEnd": {
          // 句末结果会进入累计列表，停止时整体返回
          const sentence = frame.payload?.result ?? "";
          if (sentence) {
            this.transcriptChars += sentence.length;
            this.finals.push(sentence);
            this.handleFinal(sentence);
          }
          break;
        }
        case "TranscriptionCompleted":
          this.rejectReady?.(new Error("ASR completed before transcription started"));
          this.finishRecognition();
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(LOG_PREFIX, "解析响应失败:", err);
    }
  }

  /** 申请阿里云 NLS 临时 token（CreateToken，RPC 风格签名） */
  private async getToken(accessKeyId: string, accessKeySecret: string): Promise<string> {
    const pairs: [string, string][] = [
      ["AccessKeyId", accessKeyId], ["Action", "CreateToken"], ["Format", "JSON"], ["RegionId", "cn-shanghai"],
      ["SignatureMethod", "HMAC-SHA256"], ["SignatureNonce", randomUUID().replace(/-/g, "")],
      ["SignatureVersion", "1.0"], ["Timestamp", new Date().toISOString().replace(/\.\d+Z$/, "Z")], ["Version", "2019-02-28"],
    ];

    // 规范化查询串：按参数名升序拼接
    const query = pairs
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    // 待签字符串；HMAC 密钥为 AccessKeySecret 追加一个 "&"
    const toSign = `GET&%2F&${encodeURIComponent(query)}`;
    const digest = createHmac("sha256", `${accessKeySecret}&`).update(toSign).digest("base64");
    const requestUrl = `https://nls-meta.cn-shanghai.aliyuncs.com/?${query}&Signature=${encodeURIComponent(digest)}`;

    const res = await fetch(requestUrl, { signal: this.tokenAbort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { Token?: { Id?: string }; errmsg?: string };
    const tokenId = body.Token?.Id;
    if (!tokenId) throw new Error(body.errmsg || "token 获取失败");
    return tokenId;
  }
}
