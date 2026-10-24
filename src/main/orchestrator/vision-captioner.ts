import { resolveTimeoutPolicy } from "../runtime-policy";

export interface VisionConfig { model: string; apiKey: string; baseUrl: string }
export type VisionImage = { base64: string; mime: string } | { url: string };
const captionDeadlineMs = resolveTimeoutPolicy({ stage: "vision-caption" }).totalMs;

function buildInstruction(userQuery: string): string {
  return userQuery && userQuery.trim()
    ? `你是图片分析助手。用户给你一张图，用户的问题如下：\n"${userQuery}"\n请基于图片直接回答用户的问题。回答务必简洁，直接针对问题给出结论，不要过度展开无关细节。`
    : "你是图片分析助手。用户给你一张图，但没有提出具体问题。\n请客观描述这张图片：主要物体、场景、可见文字和重要细节，不要无依据猜测。描述控制在 200 字以内。";
}
function buildChatCompletionsUrl(baseUrl: string): string {
  const endpoint = baseUrl.trim().replace(/\/+$/, "");
  return endpoint.endsWith("/chat/completions") ? endpoint : endpoint + "/chat/completions";
}

export async function captionImage(image: VisionImage, userQuery: string, config: VisionConfig): Promise<string> {
  const instruction = buildInstruction(userQuery);
  const source = "url" in image ? image.url : "data:" + image.mime + ";base64," + image.base64;
  const payload = {
    model: config.model,
    messages: [{ role: "user", content: [{ type: "text", text: instruction }, { type: "image_url", image_url: { url: source } }] }],
    max_tokens: 512,
    stream: false,
  };
  const endpoint = buildChatCompletionsUrl(config.baseUrl);
  console.log("[Vision] 调用视觉模型:", config.model, "url=" + endpoint, "query.len=" + userQuery.length);
  const beganAt = Date.now();
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(), captionDeadlineMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST", signal: cancellation.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[Vision] 请求失败 HTTP " + response.status, detail.slice(0, 200));
      return "[错误·运行时] 视觉模型请求失败：HTTP " + response.status + " " + detail.slice(0, 200);
    }
    const completion = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    const caption = completion.choices?.[0]?.message?.content ?? "";
    if (!caption) {
      console.error("[Vision] 视觉模型未返回有效内容");
      return "[错误·运行时] 视觉模型未返回有效内容";
    }
    console.log("[Vision] 完成，耗时=" + (Date.now() - beganAt) + "ms，返回长度=" + caption.length);
    return caption;
  } catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") {
      console.error("[Vision] 请求超时");
      return "[错误·运行时] 视觉模型请求超时";
    }
    const detail = failure instanceof Error ? failure.message : String(failure);
    console.error("[Vision] 请求异常:", detail);
    return "[错误·运行时] 视觉模型请求异常：" + detail;
  } finally { clearTimeout(deadline); }
}
