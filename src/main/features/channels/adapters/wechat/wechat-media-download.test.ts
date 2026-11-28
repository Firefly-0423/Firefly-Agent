import { it, expect, vi } from "vitest";
import { createCipheriv } from "node:crypto";
import { downloadWechatMedia } from "./wechat-media-download";

it("retrieves encrypted CDN data and accepts a base64-encoded hexadecimal AES key", async () => {
  const key = Buffer.from("febadc98765432100123456789abcdef", "hex");
  const plain = Buffer.from("contract image payload");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array(encrypted), { status: 200 }));
  const media = {
    encrypt_type: 1, encrypt_query_param: "query/with spaces",
    aes_key: Buffer.from(key.toString("hex")).toString("base64"),
  };
  expect(await downloadWechatMedia(media, { fetchImpl })).toStrictEqual(plain);
  expect(fetchImpl).toHaveBeenCalledWith("https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=query%2Fwith%20spaces");
});
