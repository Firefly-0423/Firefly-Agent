import * as fs from "fs";
import * as path from "path";
import type { SocialAtom, ValidatedSocialAtomOperation } from "./types";

// 磁盘格式：{ schemaVersion: 1, atoms: [...] }，两空格缩进。
interface SocialAtomFile {
  schemaVersion: 1;
  atoms: SocialAtom[];
}

export interface SocialAtomStore {
  listActive(conversationId: string, now?: number): SocialAtom[];
  getById(id: string): SocialAtom | undefined;
  applyOperations(
    conversationId: string,
    operations: readonly ValidatedSocialAtomOperation[],
    now?: number,
  ): void;
  replaceForTest(atoms: SocialAtom[]): void;
}

type ResolveOperation = Extract<ValidatedSocialAtomOperation, { operation: "resolve" }>;
type WriteOperation = Exclude<ValidatedSocialAtomOperation, ResolveOperation>;

const isLive = (atom: SocialAtom, now: number): boolean =>
  atom.status === "active" && (typeof atom.expiresAt !== "number" || atom.expiresAt > now);

// 同一轮证据 + 同类型 + 规范化后相同内容视为重复写入（重试场景）。
const isRepeatWrite = (
  records: readonly SocialAtom[],
  incoming: SocialAtom,
  conversationId: string,
): boolean => records.some((record) => (
  record.conversationId === conversationId
  && record.type === incoming.type
  && record.evidenceTurnId === incoming.evidenceTurnId
  && record.content.trim() === incoming.content.trim()
));

export function createSocialAtomStore(filePath?: string): SocialAtomStore {
  let hydrated = false;
  let records: SocialAtom[] = [];

  const hydrate = (): void => {
    if (hydrated) return;
    hydrated = true;
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const doc = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SocialAtomFile>;
      records = Array.isArray(doc.atoms) ? doc.atoms : [];
    } catch {
      records = [];
    }
  };

  // 先写临时文件，再覆盖目标文件，最后删除临时文件。
  const persist = (): void => {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const staging = `${filePath}.tmp`;
    const body: SocialAtomFile = { schemaVersion: 1, atoms: records };
    fs.writeFileSync(staging, JSON.stringify(body, null, 2), "utf8");
    fs.copyFileSync(staging, filePath);
    fs.rmSync(staging);
  };

  const applyResolve = (
    operation: ResolveOperation,
    conversationId: string,
    now: number,
  ): void => {
    const target = records.find((record) => (
      record.id === operation.targetAtomId
      && record.conversationId === conversationId
      && record.type === "open_loop"
      && isLive(record, now)
    ));
    if (!target) return;
    target.status = "resolved";
    target.resolvedByTurnId = operation.evidenceTurnId;
  };

  const applyWrite = (
    operation: WriteOperation,
    conversationId: string,
    now: number,
  ): void => {
    const { atom } = operation;
    if (atom.conversationId !== conversationId) return;
    if (isRepeatWrite(records, atom, conversationId)) return;

    if (operation.operation === "supersede") {
      const target = records.find((record) => (
        record.id === operation.targetAtomId
        && record.conversationId === conversationId
        && isLive(record, now)
      ));
      if (!target) return;
      target.status = "superseded";
      target.supersededByAtomId = atom.id;
    }

    if (!records.some((record) => record.id === atom.id)) {
      records.push(atom);
    }
  };

  return {
    listActive(conversationId, now = Date.now()) {
      hydrate();
      return records.filter((record) => (
        record.conversationId === conversationId && isLive(record, now)
      ));
    },

    getById(id) {
      hydrate();
      return records.find((record) => record.id === id);
    },

    applyOperations(conversationId, operations, now = Date.now()) {
      hydrate();
      for (const operation of operations) {
        if (operation.operation === "resolve") {
          applyResolve(operation, conversationId, now);
        } else {
          applyWrite(operation, conversationId, now);
        }
      }
      persist();
    },

    replaceForTest(next) {
      hydrated = true;
      records = [...next];
    },
  };
}
