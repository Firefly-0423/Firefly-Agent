// vscode-jsonrpc 9.x 的 `node` 入口只出现在 package exports 里。
// 本仓库的 TypeScript 仍走 classic 解析，解析不到它，因此在这里手写子路径声明，
// 好过为此整体调整 tsconfig。
declare module "vscode-jsonrpc/node" {
  type NotificationHandler = (params: any) => void;
  type RequestHandler = (params: any) => unknown;

  export type MessageConnection = {
    listen(): void;
    dispose(): void;
    onNotification(method: string, handler: NotificationHandler): void;
    onRequest(method: string, handler: RequestHandler): void;
    sendNotification(method: string, params?: unknown): void;
    sendRequest(method: string, params?: unknown, token?: unknown): Promise<unknown>;
  };

  export const createMessageConnection: (
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ) => MessageConnection;
}
