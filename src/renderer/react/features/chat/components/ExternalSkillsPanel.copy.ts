/** Marketplace preview copy stays local to this feature; it never grants an approval. */
export function externalSkillPreviewCopy(locale: string) {
  return locale.startsWith("zh") ? {
    notice: "完整内容尚未审核。此预览只核验选定声明并读取 SKILL.md；许可仅显示文件树信息。完整审核通过前不能暂存、导入或启用。",
    action: "完整审核内容", inventory: "文件树摘要", files: "文件总数", bytes: "声明总字节数",
    licenseFiles: "许可文件（仅树信息，未核验正文或覆盖范围）", notReviewed: "尚未完成完整审核",
  } : {
    notice: "Full content has not been reviewed. This preview checks the selected declaration and reads SKILL.md; licenses show tree metadata only. Staging, importing and enabling require the complete review first.",
    action: "Review full content", inventory: "Repository tree summary", files: "Total files", bytes: "Declared total bytes",
    licenseFiles: "License files (tree metadata only; terms and coverage unverified)", notReviewed: "Full review pending",
  };
}
