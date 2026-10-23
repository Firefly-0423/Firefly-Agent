import { useRef, useEffect } from "react";
import { aguiApi } from "../pages/chat-page-bridge";
import type { ChatMessageItem } from "../components/ChatMessageList";

type ChannelMirrorPayload = {
  at: number; text: string; chatId: string; senderName?: string;
  senderId: string; channel: string; type: "bot:incoming" | "bot:outgoing";
};
type BindingSnapshot = {
  bindings: Array<{ conversationId: string; sessionId: string }>;
  externalChats: Array<{ chatId: string; channel: string; sessionId: string }>;
};
type SettingsBindingApi = { channelsContextBindingsGet: () => Promise<BindingSnapshot> };
export type UseChannelMirrorEventsDeps = {
  appendMessages: (sessionId: string, items: ChatMessageItem[]) => void;
  getActiveSessionId: () => string | undefined;
};

const channels: Record<string, string> = { qqbot: "QQ机器人", qq: "QQ", feishu: "飞书", wechat: "微信" };
const MAX_MIRROR_TEXT = 160;
let nextMirrorNumber = 0;

function channelLabel(name: string): string { return channels[name] ?? name; }
function truncate(source: string): string {
  const collapsed = source.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_MIRROR_TEXT ? collapsed.slice(0, MAX_MIRROR_TEXT) + "…" : collapsed;
}
function mirrorLine(packet: ChannelMirrorPayload): string {
  const origin = channelLabel(packet.channel);
  const person = packet.senderName || packet.chatId;
  const body = truncate(packet.text);
  const action = packet.type === "bot:outgoing" ? "回复 " : "";
  return "[" + origin + "] " + action + person + "：" + body;
}

async function resolveBoundConversation(channel: string, chatId: string): Promise<string | null> {
  const bridge = (window as typeof window & { settings?: SettingsBindingApi }).settings;
  if (!bridge?.channelsContextBindingsGet) return null;
  try {
    const bindings = await bridge.channelsContextBindingsGet();
    const external = bindings.externalChats.find((entry) => entry.channel === channel && entry.chatId === chatId);
    if (!external) return null;
    return bindings.bindings.find((entry) => entry.sessionId === external.sessionId)?.conversationId ?? null;
  } catch { return null; }
}

function parsePayload(raw: unknown): ChannelMirrorPayload | null {
  if (raw === null || typeof raw !== "object") return null;
  const fields = raw as Partial<ChannelMirrorPayload>;
  if (fields.type !== "bot:incoming" && fields.type !== "bot:outgoing") return null;
  if (typeof fields.channel !== "string" || typeof fields.chatId !== "string" || typeof fields.text !== "string") return null;
  return {
    type: fields.type, channel: fields.channel,
    senderId: typeof fields.senderId === "string" ? fields.senderId : "",
    senderName: typeof fields.senderName === "string" ? fields.senderName : undefined,
    chatId: fields.chatId, text: fields.text, at: typeof fields.at === "number" ? fields.at : Date.now(),
  };
}

export function useChannelMirrorEvents(deps: UseChannelMirrorEventsDeps): void {
  const latest = useRef(deps);
  latest.current = deps;
  const serial = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const bridge = aguiApi();
    if (!bridge?.onEvent) return;
    return bridge.onEvent((raw) => {
      const envelope = raw as { value?: unknown; name?: string; type?: string };
      if (envelope.type !== "CUSTOM" || envelope.name !== "firefly.botMessage") return;
      const packet = parsePayload(envelope.value);
      if (!packet) return;
      serial.current = serial.current.then(async () => {
        const owner = latest.current.getActiveSessionId();
        if (!owner) return;
        const binding = await resolveBoundConversation(packet.channel, packet.chatId);
        if (binding === owner) return;
        nextMirrorNumber += 1;
        latest.current.appendMessages(owner, [{
          id: `channel-mirror-${packet.at}-${nextMirrorNumber}`, role: "system", content: mirrorLine(packet),
        }]);
      }).catch(() => undefined);
    });
  }, []);
}
