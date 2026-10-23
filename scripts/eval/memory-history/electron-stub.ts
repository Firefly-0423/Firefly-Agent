// 评测在纯 Node 里运行，生产代码里的 `import { app } from "electron"` 用这个桩替代。
// 只提供模型路径探测需要的最小接口。
export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: () => process.cwd(),
};
export default { app };
