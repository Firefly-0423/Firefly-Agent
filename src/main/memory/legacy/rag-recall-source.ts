// 把早期用户记忆库登记给检索模块：检索时需要知道哪些 L2 记忆可以召回，并记录召回次数。
// 记忆库按需加载（和原来检索模块里的动态引入一致），避免启动时提前打开存储。
import { registerUserMemoryRecallSource } from "../../knowledge/rag/index";
import { feedEntityNamesToJieba } from "./entity-graph";
import { isL2LocallyRecallable } from "./memory-types";

registerUserMemoryRecallSource({
  feedEntityNames: () => feedEntityNamesToJieba(),
  async listRecallable() {
    const { memoryStore } = await import("./memory-store");
    return (await memoryStore.getAllL2()).filter(isL2LocallyRecallable);
  },
  async recordRecall(l2Id) {
    const { memoryStore } = await import("./memory-store");
    await memoryStore.updateL2RecallStats(l2Id, 1);
  },
});
