/**
 * 把 URL 压缩成可以写进日志的形式：只保留协议和主机。
 * 路径、用户名密码、查询串、片段都可能带令牌或个人信息（例如临时分享链接把令牌放在路径里），
 * 一律不进日志；有路径或查询串时只标出"有"。
 */
export function urlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname !== "/" ? "/<path>" : ""}${url.search ? "?<query>" : ""}`;
  } catch {
    return "<invalid-url>";
  }
}
