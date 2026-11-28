import { createDecipheriv } from "node:crypto";
import type { CDNMedia } from "./ilink-protocol-client";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type DownloadOptions = { fetchImpl?: FetchLike };

export function decodeWechatAesKey(value: string): Buffer {
  const encoded = value.trim();
  const hexadecimal = /^[0-9a-fA-F]{32}$/;
  if (hexadecimal.test(encoded)) return Buffer.from(encoded, "hex");
  const binary = Buffer.from(encoded, "base64");
  if (binary.length === 16) return binary;
  const text = binary.toString("utf8");
  if (hexadecimal.test(text)) return Buffer.from(text, "hex");
  throw new Error("unsupported WeChat AES key format");
}

export function decryptAesEcb(data: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`AES key must be 16 bytes, got ${key.length}`);
  const decoder = createDecipheriv("aes-128-ecb", key, null);
  const head = decoder.update(data);
  const tail = decoder.final();
  return Buffer.concat([head, tail]);
}

export async function downloadWechatMedia(media: CDNMedia, options: DownloadOptions = {}): Promise<Buffer> {
  const query = media.encrypt_query_param?.trim();
  if (!query) throw new Error("missing WeChat encrypted query param");
  const secret = decodeWechatAesKey(media.aes_key);
  const request = options.fetchImpl ?? fetch;
  const destination = `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(query)}`;
  const received = await request(destination);
  if (!received.ok) {
    const explanation = await received.text().catch(() => "");
    throw new Error(`CDN download failed: HTTP ${received.status} ${explanation.slice(0, 120)}`.trim());
  }
  const bytes = Buffer.from(await received.arrayBuffer());
  return media.encrypt_type === 0 ? bytes : decryptAesEcb(bytes, secret);
}
