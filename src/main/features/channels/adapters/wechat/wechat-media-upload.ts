import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { CDNMedia, GetUploadUrlRequest, GetUploadUrlResponse } from "./ilink-protocol-client";
import { MediaType } from "./ilink-protocol-client";
export { MediaType };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type UploadOptions = { fetchImpl?: FetchLike; fileKey?: string; aesKey?: Buffer };
interface UploadClient { getUploadUrl(req: GetUploadUrlRequest): Promise<GetUploadUrlResponse>; }

export function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`AES key must be 16 bytes, got ${key.length}`);
  const encoder = createCipheriv("aes-128-ecb", key, null);
  const head = encoder.update(data);
  const tail = encoder.final();
  return Buffer.concat([head, tail]);
}

export async function uploadWechatMedia(client: UploadClient, userId: string, data: Buffer, mediaType: MediaType, options: UploadOptions = {}): Promise<CDNMedia> {
  const secret = options.aesKey ?? randomBytes(16);
  const uploadId = options.fileKey ?? randomBytes(16).toString("hex");
  const encrypted = encryptAesEcb(data, secret);
  const ticket = await client.getUploadUrl({
    filekey: uploadId,
    media_type: mediaType, to_user_id: userId, rawsize: data.length,
    rawfilemd5: createHash("md5").update(data).digest("hex"),
    filesize: encrypted.length,
    no_need_thumb: true,
    aeskey: secret.toString("hex"),
  });
  const fullAddress = ticket.upload_full_url?.trim();
  if (!fullAddress && !ticket.upload_param) throw new Error("getuploadurl returned no upload URL");
  const address = fullAddress || `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(ticket.upload_param)}&filekey=${encodeURIComponent(uploadId)}`;
  const request = options.fetchImpl ?? fetch;
  const acknowledgement = await request(address, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(encrypted),
  });
  if (!acknowledgement.ok) {
    const explanation = acknowledgement.headers.get("x-error-message") ?? `HTTP ${acknowledgement.status}`;
    throw new Error(`CDN upload failed: ${explanation}`);
  }
  const encryptedQuery = acknowledgement.headers.get("x-encrypted-param");
  if (!encryptedQuery) throw new Error("CDN upload response missing x-encrypted-param header");
  return {
    encrypt_query_param: encryptedQuery,
    aes_key: Buffer.from(secret.toString("hex"), "utf8").toString("base64"),
    encrypt_type: 1,
  };
}

export async function uploadWechatMediaFile(client: UploadClient, userId: string, filePath: string, mediaType: MediaType): Promise<CDNMedia> {
  const contents = await fs.readFile(filePath);
  return uploadWechatMedia(client, userId, contents, mediaType);
}
