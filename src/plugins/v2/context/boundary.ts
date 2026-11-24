import {
  EXTERNAL_DATA_TAG,
  EXTERNAL_DATA_UNTRUSTED_POLICY,
} from "../../../shared/external-data-policy";

export { EXTERNAL_DATA_TAG, EXTERNAL_DATA_UNTRUSTED_POLICY };

export function escapeExternalDataAttribute(value: string): string {
  return value
    .replace(/[\r\n\u0000-\u001f\u007f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 转义不可信文本中的 XML/HTML 边界字符，防止插件返回 `</external-data>` 或 `</runtime_context>` 逃逸出数据边界。
 */
export function escapeExternalDataText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface ExternalDataEnvelope {
  source: string;
  pluginName?: string;
  providerId?: string;
  heading?: string;
  content: string;
}

export function wrapExternalData(envelope: ExternalDataEnvelope): string {
  const attrs = [`source="${escapeExternalDataAttribute(envelope.source)}"`];
  if (envelope.pluginName) {
    attrs.push(`plugin="${escapeExternalDataAttribute(envelope.pluginName)}"`);
  }
  if (envelope.providerId) {
    attrs.push(`id="${escapeExternalDataAttribute(envelope.providerId)}"`);
  }
  const bodyParts: string[] = [];
  if (envelope.heading && envelope.heading.trim()) {
    bodyParts.push(`### ${escapeExternalDataText(envelope.heading.trim())}`);
  }
  if (envelope.content.trim()) {
    bodyParts.push(escapeExternalDataText(envelope.content.trim()));
  }
  const body = bodyParts.join("\n");
  return `<${EXTERNAL_DATA_TAG} ${attrs.join(" ")}>\n${body}\n</${EXTERNAL_DATA_TAG}>`;
}
