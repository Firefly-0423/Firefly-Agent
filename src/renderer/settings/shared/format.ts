// 设置面板共用的时间与文本格式。
export function formatDateTime(timestamp: number): string {
  const missingTime = "暂无时间";
  if (!timestamp) return missingTime;

  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return missingTime;

  const fields: Intl.DateTimeFormatOptions = {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  };
  return instant.toLocaleString("zh-CN", fields);
}

export function escapeHtml(text: string): string {
  // 先处理 &，避免再次转义后续生成的实体。
  let escaped = text.replace(/&/g, "&amp;");
  escaped = escaped.replace(/</g, "&lt;");
  escaped = escaped.replace(/>/g, "&gt;");
  escaped = escaped.replace(/\"/g, "&quot;");
  return escaped.replace(/'/g, "&#39;");
}
