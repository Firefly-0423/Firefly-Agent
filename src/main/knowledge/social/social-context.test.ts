import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSocialContextBlock } from "./context";
import { rankSocialAtoms } from "./retrieval";
import { createSocialAtomStore } from "./store";
import type { SocialAtom, ValidatedSocialAtomOperation } from "./types";

const DAY = 86_400_000;
const BASE = Date.parse("2026-03-01T00:00:00Z");

function mk(id: string, content: string, patch: Partial<SocialAtom> = {}): SocialAtom {
  return {
    id,
    conversationId: "c1",
    type: "long_term",
    content,
    evidenceTurnId: `t-${id}`,
    evidenceQuote: content.slice(0, 4),
    createdAt: BASE,
    status: "active",
    ...patch,
  };
}

const loopAtom = (id: string, patch: Partial<SocialAtom> = {}): SocialAtom =>
  mk(id, `话题 ${id} 等待回应`, { type: "open_loop", expiresAt: BASE + 3 * DAY, ...patch });

const idsOf = (list: readonly SocialAtom[]): string[] => list.map((a) => a.id);

const addOp = (atom: SocialAtom): ValidatedSocialAtomOperation => ({ operation: "add", atom });
const resolveOp = (target: string): ValidatedSocialAtomOperation => ({
  operation: "resolve",
  targetAtomId: target,
  evidenceTurnId: "user-turn",
  evidenceQuote: "好的",
});

describe("存储：读取与隔离", () => {
  it("按对话隔离，并排除过期与非活跃原子", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([
      mk("keep", "保留"),
      mk("elsewhere", "别处", { conversationId: "c2" }),
      mk("lapsed", "过期", { expiresAt: BASE + 10 }),
      mk("replaced", "被取代", { status: "superseded" }),
      mk("closed", "已关闭", { type: "open_loop", status: "resolved" }),
    ]);
    expect(idsOf(store.listActive("c1", BASE + 20))).toEqual(["keep"]);
    expect(idsOf(store.listActive("c2", BASE + 20))).toEqual(["elsewhere"]);
    expect(store.listActive("nobody", BASE)).toEqual([]);
  });

  it("过期边界：expiresAt 等于当前时刻即视为失效", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([mk("edge", "边界", { expiresAt: BASE + 50 })]);
    expect(store.listActive("c1", BASE + 49)).toHaveLength(1);
    expect(store.listActive("c1", BASE + 50)).toHaveLength(0);
  });

  it("getById 能取到任何状态的原子，找不到则为 undefined", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([mk("x", "内容", { status: "superseded" })]);
    expect(store.getById("x")?.status).toBe("superseded");
    expect(store.getById("y")).toBeUndefined();
  });

  it("replaceForTest 复制传入数组，之后修改外部数组不影响存储", () => {
    const source = [mk("a", "甲")];
    const store = createSocialAtomStore();
    store.replaceForTest(source);
    source.push(mk("b", "乙"));
    expect(idsOf(store.listActive("c1", BASE))).toEqual(["a"]);
  });
});

describe("存储：写入语义", () => {
  it("add 把新原子追加到列表末尾", () => {
    const store = createSocialAtomStore();
    store.applyOperations("c1", [addOp(mk("a", "甲")), addOp(mk("b", "乙", { evidenceTurnId: "t-2" }))], BASE);
    expect(idsOf(store.listActive("c1", BASE))).toEqual(["a", "b"]);
  });

  it("supersede 追加新原子并把旧原子标记为被取代、记录继任者", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([mk("old", "住在成都")]);
    store.applyOperations("c1", [{
      operation: "supersede",
      atom: mk("new", "住在重庆", { evidenceTurnId: "t-new" }),
      targetAtomId: "old",
    }], BASE);

    expect(store.getById("old")).toMatchObject({ status: "superseded", supersededByAtomId: "new" });
    expect(idsOf(store.listActive("c1", BASE))).toEqual(["new"]);
  });

  it("supersede 的目标找不到、已失效或在别的对话时，整条操作被丢弃（新原子也不写入）", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([
      mk("gone", "已被取代", { status: "superseded" }),
      mk("late", "过期了", { expiresAt: BASE - 1 }),
      mk("alien", "别的对话", { conversationId: "c2" }),
    ]);
    for (const target of ["missing", "gone", "late", "alien"]) {
      store.applyOperations("c1", [{
        operation: "supersede",
        atom: mk(`n-${target}`, "新内容", { evidenceTurnId: `e-${target}` }),
        targetAtomId: target,
      }], BASE);
      expect(store.getById(`n-${target}`), target).toBeUndefined();
    }
    expect(store.getById("alien")?.status).toBe("active");
  });

  it("原子自带的 conversationId 与操作所在对话不符时被忽略", () => {
    const store = createSocialAtomStore();
    store.applyOperations("c1", [addOp(mk("z", "错位", { conversationId: "c2" }))], BASE);
    expect(store.getById("z")).toBeUndefined();
  });

  it("同一证据回合、同类型、去空白后内容相同的写入视为重试，只保留第一条", () => {
    const store = createSocialAtomStore();
    store.applyOperations("c1", [addOp(mk("first", "喜欢咖啡", { evidenceTurnId: "t-9" }))], BASE);
    store.applyOperations("c1", [addOp(mk("again", "  喜欢咖啡\n", { evidenceTurnId: "t-9" }))], BASE);
    expect(idsOf(store.listActive("c1", BASE))).toEqual(["first"]);
  });

  it("证据回合、类型或内容任一不同都不算重复", () => {
    const store = createSocialAtomStore();
    store.applyOperations("c1", [
      addOp(mk("p", "喜欢咖啡", { evidenceTurnId: "t-1" })),
      addOp(mk("q", "喜欢咖啡", { evidenceTurnId: "t-2" })),
      addOp(mk("r", "喜欢咖啡", { evidenceTurnId: "t-1", type: "short_term", expiresAt: BASE + DAY })),
      addOp(mk("s", "喜欢红茶", { evidenceTurnId: "t-1" })),
    ], BASE);
    expect(idsOf(store.listActive("c1", BASE))).toEqual(["p", "q", "r", "s"]);
  });

  it("id 已存在时不会重复追加", () => {
    const store = createSocialAtomStore();
    store.applyOperations("c1", [addOp(mk("same", "甲", { evidenceTurnId: "t-1" }))], BASE);
    store.applyOperations("c1", [addOp(mk("same", "乙", { evidenceTurnId: "t-2" }))], BASE);
    expect(store.getById("same")?.content).toBe("甲");
    expect(store.listActive("c1", BASE)).toHaveLength(1);
  });

  it("重复的 supersede 重试不会把旧原子再次改写", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([mk("o1", "旧"), mk("o2", "另一个旧")]);
    const next = mk("n1", "新", { evidenceTurnId: "t-5" });
    store.applyOperations("c1", [{ operation: "supersede", atom: next, targetAtomId: "o1" }], BASE);
    store.applyOperations("c1", [{
      operation: "supersede",
      atom: { ...next, id: "n2" },
      targetAtomId: "o2",
    }], BASE);
    expect(store.getById("o2")?.status).toBe("active");
    expect(store.getById("n2")).toBeUndefined();
  });

  it("resolve 只关闭活跃的开放话题，并记录回应它的回合，不新增原子", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([loopAtom("lp")]);
    store.applyOperations("c1", [resolveOp("lp")], BASE + 1);
    expect(store.getById("lp")).toMatchObject({ status: "resolved", resolvedByTurnId: "user-turn" });
    expect(store.listActive("c1", BASE + 1)).toEqual([]);
  });

  it("resolve 对长期事实、过期话题、他对话话题、不存在的目标均无效", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([
      mk("fact", "事实"),
      loopAtom("stale", { expiresAt: BASE + 5 }),
      loopAtom("foreign", { conversationId: "c2" }),
    ]);
    store.applyOperations("c1", ["fact", "stale", "foreign", "ghost"].map(resolveOp), BASE + 10);

    expect(store.getById("fact")?.status).toBe("active");
    expect(store.getById("stale")?.status).toBe("active");
    expect(store.getById("foreign")?.status).toBe("active");
    expect(store.getById("fact")?.resolvedByTurnId).toBeUndefined();
  });

  it("同一批操作按顺序生效：先新增话题再关闭它", () => {
    const store = createSocialAtomStore();
    store.applyOperations("c1", [addOp(loopAtom("fresh")), resolveOp("fresh")], BASE);
    expect(store.getById("fresh")?.status).toBe("resolved");
  });

  it("未传入 now 时以系统当前时间判断有效期", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([
      mk("past", "过去", { expiresAt: Date.now() - 60_000 }),
      mk("future", "将来", { expiresAt: Date.now() + 60_000 }),
    ]);
    expect(idsOf(store.listActive("c1"))).toEqual(["future"]);
  });
});

describe("存储：磁盘持久化", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-atoms-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("写盘内容是缩进两格的 {schemaVersion:1, atoms}，且不遗留临时文件", () => {
    const file = path.join(dir, "atoms.json");
    const store = createSocialAtomStore(file);
    const atom = mk("disk", "写进磁盘");
    store.applyOperations("c1", [addOp(atom)], BASE);

    expect(fs.readFileSync(file, "utf8")).toBe(
      JSON.stringify({ schemaVersion: 1, atoms: [atom] }, null, 2),
    );
    expect(fs.readdirSync(dir)).toEqual(["atoms.json"]);
  });

  it("目标目录不存在时会自动创建", () => {
    const file = path.join(dir, "deep", "er", "atoms.json");
    createSocialAtomStore(file).applyOperations("c1", [addOp(mk("n", "嵌套"))], BASE);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("新建的存储实例能读到此前写入的原子，并在其上继续追加", () => {
    const file = path.join(dir, "atoms.json");
    createSocialAtomStore(file).applyOperations("c1", [addOp(mk("one", "第一"))], BASE);

    const reopened = createSocialAtomStore(file);
    expect(idsOf(reopened.listActive("c1", BASE))).toEqual(["one"]);
    reopened.applyOperations("c1", [addOp(mk("two", "第二", { evidenceTurnId: "t-2" }))], BASE);

    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.atoms.map((a: SocialAtom) => a.id)).toEqual(["one", "two"]);
  });

  it("状态变更（取代、关闭）同样被保存", () => {
    const file = path.join(dir, "atoms.json");
    const store = createSocialAtomStore(file);
    store.applyOperations("c1", [addOp(loopAtom("lp"))], BASE);
    store.applyOperations("c1", [resolveOp("lp")], BASE);

    const reopened = createSocialAtomStore(file);
    expect(reopened.getById("lp")?.status).toBe("resolved");
  });

  it.each([
    ["损坏的 JSON", "{not valid"],
    ["缺少 atoms 数组", JSON.stringify({ schemaVersion: 1 })],
    ["atoms 不是数组", JSON.stringify({ schemaVersion: 1, atoms: {} })],
    ["空文件", ""],
  ])("磁盘文件为%s时当作空库，随后可正常写入", (_label, body) => {
    const file = path.join(dir, "atoms.json");
    fs.writeFileSync(file, body, "utf8");
    const store = createSocialAtomStore(file);
    expect(store.listActive("c1", BASE)).toEqual([]);

    store.applyOperations("c1", [addOp(mk("fresh", "重新开始"))], BASE);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).atoms).toHaveLength(1);
  });

  it("没有 filePath 的存储只在内存中工作", () => {
    const store = createSocialAtomStore();
    store.applyOperations("c1", [addOp(mk("mem", "内存"))], BASE);
    expect(store.getById("mem")).toBeDefined();
  });
});

describe("检索排序", () => {
  const NOW = BASE + 40 * DAY;

  it("相关度更高的原子排在前面，无词汇重叠的事实不返回", () => {
    const ranked = rankSocialAtoms("金毛狗", [
      mk("dog", "用户养了一只金毛狗", { createdAt: NOW - DAY }),
      mk("tea", "用户喜欢喝乌龙茶", { createdAt: NOW - DAY }),
    ], { now: NOW });
    expect(idsOf(ranked)).toEqual(["dog"]);
  });

  it("相关度相同的情况下，较新的原子优先", () => {
    const ranked = rankSocialAtoms("摄影", [
      mk("older", "用户爱好摄影", { createdAt: NOW - 90 * DAY }),
      mk("newer", "用户爱好摄影", { createdAt: NOW - 1 * DAY }),
    ], { now: NOW });
    expect(idsOf(ranked)).toEqual(["newer", "older"]);
  });

  it("极久远的原子被衰减但只要有匹配仍会返回", () => {
    const ranked = rankSocialAtoms("摄影", [mk("ancient", "用户爱好摄影", { createdAt: NOW - 3000 * DAY })], { now: NOW });
    expect(idsOf(ranked)).toEqual(["ancient"]);
  });

  it("limit 截断结果；默认上限是 5；limit 为 0 或负数时返回空", () => {
    const atoms = Array.from({ length: 9 }, (_, i) => mk(`k${i}`, `用户在练习钢琴 第${i}天`, { createdAt: NOW - i * 1000 }));
    expect(rankSocialAtoms("钢琴", atoms, { now: NOW })).toHaveLength(5);
    expect(rankSocialAtoms("钢琴", atoms, { now: NOW, limit: 2 })).toHaveLength(2);
    expect(rankSocialAtoms("钢琴", atoms, { now: NOW, limit: 20 })).toHaveLength(9);
    expect(rankSocialAtoms("钢琴", atoms, { now: NOW, limit: 0 })).toEqual([]);
    expect(rankSocialAtoms("钢琴", atoms, { now: NOW, limit: -3 })).toEqual([]);
  });

  it("过期、被取代、已关闭的原子不参与排序", () => {
    const ranked = rankSocialAtoms("摄影", [
      mk("live", "用户爱好摄影", { createdAt: NOW - DAY }),
      mk("expired", "用户爱好摄影", { createdAt: NOW - DAY, expiresAt: NOW }),
      mk("sup", "用户爱好摄影", { createdAt: NOW - DAY, status: "superseded" }),
      mk("res", "用户爱好摄影", { createdAt: NOW - DAY, status: "resolved" }),
    ], { now: NOW });
    expect(idsOf(ranked)).toEqual(["live"]);
  });

  it("不相关的查询下，开放话题仍可浮现，事实不会", () => {
    const ranked = rankSocialAtoms("晚安", [
      mk("fact", "用户喜欢潜水", { createdAt: NOW - 1000 }),
      loopAtom("loop", { createdAt: NOW - 1000, expiresAt: NOW + DAY }),
    ], { now: NOW });
    expect(idsOf(ranked)).toEqual(["loop"]);
  });

  it("空查询只返回开放话题", () => {
    const ranked = rankSocialAtoms("   ", [
      mk("fact", "用户喜欢潜水", { createdAt: NOW - 1000 }),
      loopAtom("loop", { createdAt: NOW - 1000, expiresAt: NOW + DAY }),
    ], { now: NOW });
    expect(idsOf(ranked)).toEqual(["loop"]);
  });

  it("没有任何候选时返回空数组", () => {
    expect(rankSocialAtoms("anything", [], { now: NOW })).toEqual([]);
  });

  it("英文查询大小写不敏感", () => {
    const ranked = rankSocialAtoms("PIANO", [
      mk("en", "User practices Piano daily", { createdAt: NOW - DAY }),
      mk("zh", "用户喜欢海边", { createdAt: NOW - DAY }),
    ], { now: NOW });
    expect(idsOf(ranked)).toEqual(["en"]);
  });

  it("不会修改传入的数组，也不会返回原对象之外的东西", () => {
    const atoms = [mk("a", "用户爱好摄影", { createdAt: NOW - DAY }), mk("b", "无关内容", { createdAt: NOW })];
    const snapshot = [...atoms];
    const ranked = rankSocialAtoms("摄影", atoms, { now: NOW });
    expect(atoms).toEqual(snapshot);
    expect(ranked[0]).toBe(atoms[0]);
  });

  it("未提供 now 时以当前时间计算有效期", () => {
    const ranked = rankSocialAtoms("摄影", [
      mk("ok", "用户爱好摄影", { createdAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 }),
      mk("dead", "用户爱好摄影", { createdAt: Date.now() - 1000, expiresAt: Date.now() - 60_000 }),
    ]);
    expect(idsOf(ranked)).toEqual(["ok"]);
  });
});

describe("上下文文本编译", () => {
  const facts = (n: number): SocialAtom[] =>
    Array.from({ length: n }, (_, i) => mk(`f${i}`, `事实内容${i}`));
  const loops = (n: number): SocialAtom[] =>
    Array.from({ length: n }, (_, i) => loopAtom(`l${i}`, { content: `话题内容${i}` }));

  it("没有原子时返回空字符串", () => {
    expect(compileSocialContextBlock([])).toBe("");
  });

  it("包含使用说明，并把过去与未接上的话题分成两段，每条一行", () => {
    const block = compileSocialContextBlock([mk("f", "用户爱潜水"), loopAtom("l", { content: "还没回答周末安排" })]);
    const lines = block.split("\n");
    const pastAt = lines.indexOf("相关的过去：");
    const loopAt = lines.indexOf("尚未接上的话题：");
    expect(pastAt).toBeGreaterThan(0);
    expect(loopAt).toBeGreaterThan(pastAt);
    expect(lines[pastAt + 1]).toBe("- 用户爱潜水");
    expect(lines[loopAt + 1]).toBe("- 还没回答周末安排");
    expect(block).toContain("不要复述这份背景");
  });

  it("只有事实时不输出话题小标题；只有话题时不输出过去小标题", () => {
    const onlyFacts = compileSocialContextBlock(facts(1));
    const onlyLoops = compileSocialContextBlock(loops(1));
    expect(onlyFacts).toContain("相关的过去：");
    expect(onlyFacts).not.toContain("尚未接上的话题：");
    expect(onlyLoops).toContain("尚未接上的话题：");
    expect(onlyLoops).not.toContain("相关的过去：");
  });

  it("短期事实与长期事实同属“过去”段", () => {
    const block = compileSocialContextBlock([
      mk("lt", "长期的"),
      mk("st", "短期的", { type: "short_term", expiresAt: BASE + DAY }),
    ]);
    expect(block).toContain("- 长期的\n- 短期的");
  });

  it("每一段最多 5 条，保持传入顺序", () => {
    const block = compileSocialContextBlock([...facts(8), ...loops(7)]);
    const bullets = block.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets).toHaveLength(10);
    expect(bullets.slice(0, 5)).toEqual([0, 1, 2, 3, 4].map((i) => `- 事实内容${i}`));
    expect(bullets.slice(5)).toEqual([0, 1, 2, 3, 4].map((i) => `- 话题内容${i}`));
    expect(block).not.toContain("事实内容5");
    expect(block).not.toContain("话题内容5");
  });

  it("不会泄露证据字段等内部信息", () => {
    const block = compileSocialContextBlock([mk("secret", "普通内容", { evidenceQuote: "不该出现的引文" })]);
    expect(block).not.toContain("不该出现的引文");
    expect(block).not.toContain("secret");
    expect(block).not.toContain("t-secret");
  });
});
