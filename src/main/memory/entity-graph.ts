// 轻量实体关系图谱
//
// 实体与关系由 Memory Judge 的模型调用顺带产出，在这里落盘并做关键词检索，
// 用来回答纯向量检索不擅长的关系型问题（例如“用户提过的朋友是谁”）。
// 数据存在 userData/entity-graph.json，与 memory.json 并列。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { registerJiebaCustomWord, registerJiebaCustomWords } from "../rag/retriever";
import { logger, LogTag } from "../logger";

export type EntityNode = {
  lastMentionedAt: number;
  firstMentionedAt: number;
  mentionCount: number;
  /** 其他叫法 */
  aliases: string[];
  type: "person" | "place" | "concept" | "preference" | "organization";
  name: string;
  id: string;
};

export type EntityRelation = {
  /** 累计提及次数 */
  strength: number;
  /** 取值 0.0 ~ 1.0 */
  confidence: number;
  /** 例如 likes / works_at / lives_in / friend_of / owns */
  relation: string;
  targetId: string;
  sourceId: string;
  id: string;
};

type EntityGraphData = {
  relations: EntityRelation[];
  entities: EntityNode[];
};

/** judge 抽取出的实体（不再用正则从原文硬抽，避免把标点、表情之类的碎片当成实体） */
export type ExtractedEntity = {
  aliases?: string[];
  type: EntityNode["type"];
  name: string;
};

const TYPE_LABELS: Record<EntityNode["type"], string> = {
  person: "人物",
  place: "地点",
  organization: "组织",
  preference: "偏好",
  concept: "概念",
};

const graphFile = (): string => path.join(path.join(app.getPath("userData")), "entity-graph.json");

const emptyGraph = (): EntityGraphData => ({ entities: [], relations: [] });

class EntityGraph {
  private cache: EntityGraphData | null = null;

  load(): EntityGraphData {
    if (this.cache) return this.cache;
    let loaded: EntityGraphData;
    try {
      const file = graphFile();
      loaded = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf8")) as EntityGraphData)
        : emptyGraph();
    } catch {
      loaded = emptyGraph();
    }
    this.cache = loaded;
    return loaded;
  }

  save(): void {
    if (!this.cache) return;
    const file = graphFile();
    const folder = path.dirname(file);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.cache, null, 2), "utf8");
  }

  /** 将 judge 产出的实体并入图谱：已存在的累加提及并合并别名，新的则创建，有变化才落盘 */
  ingestEntities(extracted: ExtractedEntity[]): void {
    if (extracted.length === 0) return;
    const graph = this.load();
    const now = Date.now();
    let dirty = false;

    for (const item of extracted) {
      const name = item.name?.trim();
      if (!name || name.length < 2) continue;
      const cleanedAliases = (item.aliases ?? []).map((a) => a.trim());

      // 大小写不敏感：模型对同一实体的拼写大小写并不稳定，保留最先存入的写法。
      const folded = name.toLowerCase();
      const known = graph.entities.find((e) => e.name.toLowerCase() === folded || e.aliases.some((a) => a.toLowerCase() === folded));
      if (!known) {
        const taken = new Set<string>([folded]);
        graph.entities.push({
          id: `ent_${now}_${Math.random().toString(36).slice(2, 8)}`,
          name,
          type: item.type,
          aliases: cleanedAliases.filter((a) => {
            const key = a.toLowerCase();
            if (!a || taken.has(key)) return false;
            taken.add(key);
            return true;
          }),
          mentionCount: 1,
          firstMentionedAt: now,
          lastMentionedAt: now,
        });
        dirty = true;
        // 新实体马上告诉分词器，避免之后被错误切开
        this.feedSingleName(name);
        continue;
      }

      known.mentionCount++;
      known.lastMentionedAt = now;
      // 提及次数和时间也要落盘，否则重启后会丢失。
      dirty = true;
      const taken = new Set<string>([known.name, ...known.aliases].map((x) => x.toLowerCase()));
      const fresh = cleanedAliases.filter((a) => {
        const key = a.toLowerCase();
        if (!a || taken.has(key)) return false;
        taken.add(key);
        return true;
      });
      if (fresh.length > 0) {
        known.aliases.push(...fresh);
        fresh.forEach((a) => this.feedSingleName(a));
      }
    }

    if (dirty) this.save();
  }

  /**
   * 把名称登记进 jieba 自定义词表。
   * @node-rs/jieba 没有运行时插词接口，这里只是向 retriever 的词表登记，
   * 由 retriever.tokenize() 在切词后把被拆散的自定义词合并回来。
   */
  private feedSingleName(name: string): void {
    registerJiebaCustomWord(name);
  }

  /** 按关键词查找相关实体及其出入边，返回可读文本；没有命中返回空串 */
  search(query: string): string {
    const { entities, relations } = this.load();
    if (entities.length === 0) return "";

    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = entities.filter((e) =>
      tokens.some((t) => e.name.toLowerCase().includes(t) || e.aliases.some((a) => a.toLowerCase().includes(t))),
    );
    if (hits.length === 0) return "";

    const nameOf = (id: string): string | undefined => entities.find((e) => e.id === id)?.name;
    const out: string[] = [];

    for (const entity of hits) {
      const suffix = entity.mentionCount > 1 ? `（提及${entity.mentionCount}次）` : "";
      out.push(`· ${entity.name}（${TYPE_LABELS[entity.type]}）${suffix}`);

      for (const rel of relations) {
        if (rel.sourceId !== entity.id) continue;
        const other = nameOf(rel.targetId);
        if (other !== undefined) out.push(`  → ${rel.relation} ${other}`);
      }
      for (const rel of relations) {
        if (rel.targetId !== entity.id) continue;
        const other = nameOf(rel.sourceId);
        if (other !== undefined) out.push(`  ← ${other} ${rel.relation}`);
      }
    }

    return out.join("\n");
  }

  /** 清空图谱并落盘 */
  reset(): void {
    this.cache = emptyGraph();
    this.save();
  }
}

/** 全部实体名与别名（去重，长度不少于 2） */
export function getAllEntityNames(): string[] {
  const unique = new Set<string>();
  for (const e of entityGraph.load().entities) {
    unique.add(e.name);
    e.aliases.forEach((a) => unique.add(a));
  }
  return Array.from(unique).filter((n) => n.length >= 2);
}

/**
 * 把图谱里所有实体名登记到 jieba 自定义词表（启动后、图谱更新后调用），
 * 这样“流萤”“小鹿”之类的核心名词不会被误切。
 */
export async function feedEntityNamesToJieba(): Promise<void> {
  const names = getAllEntityNames();
  if (names.length === 0) return;
  registerJiebaCustomWords(names);
  logger.info(LogTag.EntityGraph, `registered ${names.length} entity names into jieba custom dictionary`);
}

export const entityGraph = new EntityGraph();
