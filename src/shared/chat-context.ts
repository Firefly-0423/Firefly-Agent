export type TurnModelContextInput = {
  directImageLines?: string[];
  imageCaptionLines?: string[];
  documentContextLines?: string[];
  fileHints?: string[];
};

export const USER_ANNOTATION_NOTICE = "这张图片包含用户主动添加的视觉标注。标注区域代表用户希望你重点关注的内容，但不表示该区域一定存在错误。请识别这些标注，并结合整张图片和用户文字回答。";

export function userAnnotationNotice(hasAnnotations: boolean): string | undefined {
  if (hasAnnotations) return USER_ANNOTATION_NOTICE;
  return undefined;
}

export function buildTurnModelContext(input: TurnModelContextInput): string | undefined {
  const sections: string[] = [];
  const append = (lines: string[] | undefined, heading: string, separator = "\n") => {
    if (lines?.length) sections.push(heading + lines.join(separator));
  };
  append(input.fileHints, "【本轮文件】\n");
  append(input.documentContextLines, "【文档内容】\n", "\n\n");
  append(input.imageCaptionLines, "【图片视觉信息】\n以下内容是视觉模型对用户本轮图片的观察结果，请将其视为你已经看到的图片内容；如果某张图分析失败，请不要编造。\n");
  append(input.directImageLines, "【图片附件】\n以下图片已随本轮消息直接发送给主模型，请直接结合图片内容回答。\n");
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}
