/**
 * SDK 入口：对外转出宿主的公开契约与 Manifest 校验函数。
 * ./api 由构建脚本从 src/plugins/api.ts 同步而来，
 * verify-package 会核对这两份文件内容一致。
 */
export * from "./api";
export * from "./validate-manifest";
