import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isPluginHostError } from "../../plugins/api";
import { createPluginSecretsService, type SafeStorageLike } from "./secrets-service";

const MARK = Buffer.from("«sealed»");

/** 把每个字节与固定掩码异或：可逆，但字节序列里不会出现原文字面量。 */
const scramble = (bytes: Uint8Array): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0x5a));

/** 假的安全存储：固定标记 + 异或后的字节，落盘内容里不含明文本身。 */
function sealer(opts: { available?: boolean; failDecrypt?: boolean } = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => opts.available ?? true,
    encryptString: (s) => Buffer.concat([MARK, scramble(Buffer.from(s, "utf8"))]),
    decryptString: (b) => {
      if (opts.failDecrypt) throw new Error("bad blob");
      return scramble(b.subarray(MARK.length)).toString("utf8");
    },
  };
}

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ff-sec-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function open(id = "demo.plugin", storage: SafeStorageLike = sealer(), signal?: AbortSignal) {
  const root = join(base, id, "vault");
  return { root, svc: createPluginSecretsService({ pluginId: id, secretsRoot: root, storage, signal }) };
}

async function errCode(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(isPluginHostError(e)).toBe(true);
    return (e as { code?: string }).code;
  }
  return "no-error";
}

async function filesIn(dir: string) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

describe("读写与删除", () => {
  test("读取从未写入的 key 得到 undefined", async () => {
    const { svc } = open();
    expect(await svc.get("never")).toBeUndefined();
  });

  test("写入后读取得到原值，包括空串与多字节文本", async () => {
    const { svc } = open();
    await svc.set("tok", "密钥-🔑-value");
    await svc.set("blank", "");
    expect(await svc.get("tok")).toBe("密钥-🔑-value");
    expect(await svc.get("blank")).toBe("");
  });

  test("覆盖写入以最后一次为准", async () => {
    const { svc } = open();
    await svc.set("k", "one");
    await svc.set("k", "two");
    expect(await svc.get("k")).toBe("two");
  });

  test("删除已存在的 key 返回 true，之后读取为 undefined", async () => {
    const { svc } = open();
    await svc.set("k", "v");
    expect(await svc.delete("k")).toBe(true);
    expect(await svc.get("k")).toBeUndefined();
  });

  test("重复删除是幂等的，返回 false", async () => {
    const { svc } = open();
    await svc.set("k", "v");
    await svc.delete("k");
    expect(await svc.delete("k")).toBe(false);
    expect(await svc.delete("other")).toBe(false);
  });

  test("成功写入后目录里只剩一个 .enc 文件，没有临时文件", async () => {
    const { svc, root } = open();
    await svc.set("only", "1");
    await svc.set("only", "2");
    const names = await filesIn(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.enc$/);
  });
});

describe("key 的独立性", () => {
  test("仅大小写不同的 key 互不覆盖", async () => {
    const { svc } = open();
    await svc.set("Api", "upper");
    await svc.set("api", "lower");
    expect(await svc.get("Api")).toBe("upper");
    expect(await svc.get("api")).toBe("lower");
  });

  test.each(["CON", "nul", "COM1", "aux.txt"])("设备名形状的 key %s 也能正常存取", async (key) => {
    const { svc } = open();
    await svc.set(key, "ok");
    expect(await svc.get(key)).toBe("ok");
  });

  test("不同插件目录互相隔离", async () => {
    const a = open("pl-a");
    const b = open("pl-b");
    await a.svc.set("shared", "A");
    expect(await b.svc.get("shared")).toBeUndefined();
    await b.svc.set("shared", "B");
    expect(await a.svc.get("shared")).toBe("A");
    expect(await b.svc.delete("shared")).toBe(true);
    expect(await a.svc.get("shared")).toBe("A");
  });

  test("磁盘上的文件名与内容都不泄漏 key 或明文", async () => {
    const { svc, root } = open();
    await svc.set("visible-name", "plain-secret-text");
    const [name] = await filesIn(root);
    expect(name).not.toContain("visible-name");
    // 文件名必须是单向哈希（64 位小写十六进制 + .enc），可逆编码（如 base64）会暴露 key 名。
    expect(name).toMatch(/^[0-9a-f]{64}\.enc$/);
    expect(name).not.toContain(Buffer.from("visible-name").toString("base64"));
    const raw = await readFile(join(root, name));
    expect(raw.subarray(0, MARK.length).equals(MARK)).toBe(true);
    // 落盘的字节里既没有明文，也没有 key 名。
    expect(raw.includes(Buffer.from("plain-secret-text"))).toBe(false);
    expect(raw.includes(Buffer.from("visible-name"))).toBe(false);
  });
});

describe("参数校验", () => {
  test.each(["", " ", "-lead", ".dot", "a/b", "a\\b", "有中文", "x".repeat(65)])(
    "非法 key %j 被拒绝",
    async (key) => {
      const { svc } = open();
      expect(await errCode(svc.get(key))).toBe("E_INVALID_ARGUMENT");
      expect(await errCode(svc.set(key, "v"))).toBe("E_INVALID_ARGUMENT");
      expect(await errCode(svc.delete(key))).toBe("E_INVALID_ARGUMENT");
    },
  );

  test("长度 64 的 key 与含 . _ - 的 key 合法", async () => {
    const { svc } = open();
    const long = "k".repeat(64);
    await svc.set(long, "1");
    await svc.set("a.b_c-d", "2");
    expect(await svc.get(long)).toBe("1");
    expect(await svc.get("a.b_c-d")).toBe("2");
  });

  test("非字符串的值被拒绝且不产生文件", async () => {
    const { svc, root } = open();
    for (const bad of [123, null, undefined, { a: 1 }]) {
      expect(await errCode(svc.set("k", bad as unknown as string))).toBe("E_INVALID_ARGUMENT");
    }
    expect(await filesIn(root)).toEqual([]);
  });

  test("非字符串的 key 被拒绝", async () => {
    const { svc } = open();
    expect(await errCode(svc.get(7 as unknown as string))).toBe("E_INVALID_ARGUMENT");
  });
});

describe("安全存储不可用", () => {
  test("set 与 get 报 E_STORAGE_UNAVAILABLE，set 不创建任何目录或文件", async () => {
    const { svc, root } = open("p", sealer({ available: false }));
    expect(await errCode(svc.set("k", "v"))).toBe("E_STORAGE_UNAVAILABLE");
    expect(await errCode(svc.get("k"))).toBe("E_STORAGE_UNAVAILABLE");
    // 空列表不能区分「没有目录」和「建了空目录」，所以直接断言目录不存在。
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await filesIn(root)).toEqual([]);
  });

  test("delete 不依赖加密可用性", async () => {
    const healthy = open("p");
    await healthy.svc.set("k", "v");
    const degraded = createPluginSecretsService({
      pluginId: "p",
      secretsRoot: healthy.root,
      storage: sealer({ available: false }),
    });
    expect(await degraded.delete("k")).toBe(true);
  });
});

describe("停止与故障", () => {
  test("中止后三个方法全部报 E_PLUGIN_STOPPING，且停止优先于参数校验", async () => {
    const ac = new AbortController();
    const { svc } = open("p", sealer(), ac.signal);
    await svc.set("k", "v");
    ac.abort();
    expect(await errCode(svc.get("k"))).toBe("E_PLUGIN_STOPPING");
    expect(await errCode(svc.set("k", "x"))).toBe("E_PLUGIN_STOPPING");
    expect(await errCode(svc.delete("k"))).toBe("E_PLUGIN_STOPPING");
    expect(await errCode(svc.get("!!bad"))).toBe("E_PLUGIN_STOPPING");
  });

  test("中止后磁盘数据保持不变", async () => {
    const ac = new AbortController();
    const { svc, root } = open("p", sealer(), ac.signal);
    await svc.set("k", "v");
    ac.abort();
    await errCode(svc.delete("k"));
    expect(await filesIn(root)).toHaveLength(1);
  });

  test("解密失败报 E_INTERNAL，且错误信息不含原始异常文本", async () => {
    const writer = open("p");
    await writer.svc.set("k", "v");
    const broken = createPluginSecretsService({
      pluginId: "p",
      secretsRoot: writer.root,
      storage: sealer({ failDecrypt: true }),
    });
    try {
      await broken.get("k");
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe("E_INTERNAL");
      expect((e as Error).message).not.toContain("bad blob");
    }
  });

  test("目标位置被普通文件占用时 set 报 E_INTERNAL", async () => {
    const root = join(base, "blocked");
    await writeFile(root, "i am a file");
    const svc = createPluginSecretsService({ pluginId: "p", secretsRoot: root, storage: sealer() });
    expect(await errCode(svc.set("k", "v"))).toBe("E_INTERNAL");
  });

  test("key 对应的路径是目录时 get 报 E_INTERNAL（非 ENOENT 不被吞掉）", async () => {
    const { svc, root } = open("p");
    await svc.set("k", "v");
    const [name] = await filesIn(root);
    await rm(join(root, name));
    await mkdir(join(root, name));
    expect(await errCode(svc.get("k"))).toBe("E_INTERNAL");
  });
});
