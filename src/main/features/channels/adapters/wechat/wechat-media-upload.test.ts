import { expect, it, vi } from "vitest";
import { createHash, createDecipheriv } from "node:crypto";
import { MediaType, uploadWechatMedia } from "./wechat-media-upload";

it("requests encrypted upload metadata, uses the full URL and returns the CDN receipt fields", async () => {
  const key = Buffer.from("abcdef01234567899876543210fedcba", "hex");
  const plain = Buffer.from("Catalog");
  const getUploadUrl = vi.fn(async () => ({ upload_param: "unused-fallback", upload_full_url: "https://upload.invalid/media/full" }));
  const fetchImpl = vi.fn(async () => new Response(null, { status: 200, headers: { "x-encrypted-param": "receipt-query-8" } }));
  const result = await uploadWechatMedia({ getUploadUrl }, "wechat-reviewer", plain, MediaType.IMAGE, {
    aesKey: key, fileKey: "catalog-image-8", fetchImpl,
  });
  expect(getUploadUrl).toHaveBeenCalledWith({
    filekey: "catalog-image-8", media_type: MediaType.IMAGE, to_user_id: "wechat-reviewer", rawsize: 7,
    rawfilemd5: createHash("md5").update(plain).digest("hex"), filesize: 16, no_need_thumb: true, aeskey: key.toString("hex"),
  });
  expect(fetchImpl).toHaveBeenCalledWith("https://upload.invalid/media/full", expect.objectContaining({
    headers: { "Content-Type": "application/octet-stream" }, method: "POST",
  }));
  expect(result).toStrictEqual({
    aes_key: Buffer.from(key.toString("hex")).toString("base64"), encrypt_type: 1, encrypt_query_param: "receipt-query-8",
  });
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  const encrypted = fetchImpl.mock.calls[0]?.[1]?.body as Uint8Array;
  expect(Buffer.concat([decipher.update(encrypted), decipher.final()])).toStrictEqual(plain);
});
