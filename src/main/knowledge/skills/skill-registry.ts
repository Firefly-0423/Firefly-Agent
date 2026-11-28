// Skill 注册表：与 ToolRegistry 一样基于 Map，并以单例形式对外提供。
// 启动阶段由 initSkills 注入扫描结果；正文与 references 按需读取，正文读取后会缓存。

import * as fs from "fs";
import * as path from "path";
import type { SkillEntry, SkillMode, SkillModeOverrides } from "./types";
import { isExternalSkillId, parseSkillFrontmatter } from "./skill-scanner";

export class SkillRegistry {
  private availability = new Map<string, () => boolean>();
  private skills = new Map<string, SkillEntry>();
  private bodyCache = new Map<string, string>();
  private externalAccessGate: (skill: SkillEntry) => boolean = () => false;

  /** 仅主进程使用的宿主探测函数；默认会拒绝所有保留前缀的外部条目。 */
  setExternalAccessGate(probe: (skill: SkillEntry) => boolean): void {
    this.externalAccessGate = probe;
    this.bodyCache.clear();
  }

  private canAccess(skill: SkillEntry): boolean {
    if (!isExternalSkillId(skill.id)) return true;
    if (!skill.enabled || skill.external?.status !== "ready") return false;
    try { return this.externalAccessGate(skill) === true; } catch { return false; }
  }

  private remember(id: string, body: string): string {
    this.bodyCache.set(id, body);
    return body;
  }

  /** 探针通过与否；没有注册探针的条目一律视为可用。 */
  private probeAvailable(id: string): boolean {
    return this.availability.get(id)?.() ?? true;
  }

  register(skill: SkillEntry): void {
    this.bodyCache.delete(skill.id);
    this.skills.set(skill.id, { ...skill });
  }

  getEnabled(): SkillEntry[] {
    return Array.from(this.skills.values()).filter(s => s.enabled && this.canAccess(s) && this.probeAvailable(s.id));
  }

  /**
   * 按会话模式筛选启用中的 skill，判定顺序如下：
   *   1. 必须启用、可访问，并且 availability 探针通过；
   *   2. 若 overrides[skillId][mode] 有值，直接采用该值；
   *   3. 否则看 modes 字段：未声明 modes，或包含当前模式，即可见。
   * 既没有声明 modes、也没有覆盖的 skill，在所有模式下都默认可见。
   */
  getEnabledForMode(mode: SkillMode, overrides?: SkillModeOverrides): SkillEntry[] {
    if (mode !== "work" && mode !== "code") throw new Error("INVALID_SKILL_MODE");
    return Array.from(this.skills.values()).filter((s) => {
      if (!s.enabled || !this.canAccess(s) || !this.probeAvailable(s.id)) return false;
      const forced = overrides ? overrides[s.id]?.[mode] : undefined;
      if (forced !== undefined) return forced;
      return !s.modes || s.modes.includes(mode);
    });
  }

  getAll(): SkillEntry[] {
    return [...this.skills.values()];
  }

  getById(id: string): SkillEntry | undefined {
    return this.skills.get(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const target = this.skills.get(id);
    if (target) target.enabled = enabled;
  }

  unregister(id: string): boolean {
    const removed = this.skills.delete(id);
    this.availability.delete(id);
    this.bodyCache.delete(id);
    return removed;
  }

  setAvailability(id: string, probe: () => boolean): void {
    this.availability.set(id, probe);
  }

  isAvailable(id: string): boolean {
    const skill = this.skills.get(id);
    if (isExternalSkillId(id) && (!skill || !this.canAccess(skill))) return false;
    return this.probeAvailable(id);
  }

  /**
   * 惰性读取 SKILL.md 的正文（去掉 frontmatter），并缓存结果。
   * 普通 skill 沿用原有的缓存语义；外部 skill 即使命中缓存，也会重新校验宿主与来源。
   * skill 不存在或读取失败时返回 null。
   */
  getBody(id: string): string | null {
    const skill = this.skills.get(id);
    if (!skill || !this.canAccess(skill)) return null;
    const cached = this.bodyCache.get(id);
    if (cached !== undefined) return cached;
    try {
      const raw = fs.readFileSync(skill.bodyPath, "utf8");
      // 复用扫描器的纯数据解析器：头部一旦变化或不安全，就不能当作指令原样使用；无头部的旧式纯文本仍然支持
      let parseFailed = false;
      const parsed = parseSkillFrontmatter(raw, () => { parseFailed = true; });
      if (parseFailed) return null;
      const body = parsed ? parsed.body : raw.trim();
      if (!this.canAccess(skill)) return null;
      return this.remember(id, body);
    } catch {
      return null;
    }
  }

  /**
   * 读取 references 目录下的附件。
   * 防路径穿越：ref 必须出现在扫描阶段记录的 references 清单中，且不能含路径分隔符或 ".."，
   * 否则返回 null。绝不直接拿 ref 去拼路径。
   */
  getReference(id: string, ref: string): string | null {
    const skill = this.skills.get(id);
    if (!skill || !this.canAccess(skill)) return null;
    if (!skill.references.includes(ref) || /[\\/]|\.\./.test(ref)) return null;
    const refPath = path.join(skill.dirPath, "references", ref);
    let content: string;
    try {
      content = fs.readFileSync(refPath, "utf8");
    } catch {
      return null;
    }
    return this.canAccess(skill) ? content : null;
  }
}

// 全局单例
export const skillRegistry = new SkillRegistry();
