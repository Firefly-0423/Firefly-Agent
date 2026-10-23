import type { WebContents } from "electron";
export type ChannelId = "wechat" | "feishu" | "qq" | "qqbot";
export type ChannelChatType = "private" | "group";
export type ChannelMention = {
    isBot?: boolean;
    name?: string;
    userId: string;
};
export type ChannelReplyContext = {
    text?: string;
    senderName?: string;
    senderId?: string;
    messageId: string;
};
export type ChannelCapability = {
    maxTextLength: number;
    sticker: boolean;
    card: boolean;
    markdown: boolean;
    video: boolean;
    file: boolean;
    audio: boolean;
    image: boolean;
    text: boolean;
};
export type ChannelAttachment = {
    caption?: string;
    mime?: string;
    filePath?: string;
    url?: string;
    kind: "image" | "audio" | "file" | "video";
};
export type IncomingMessage = {
    _raw?: unknown;
    at: Date;
    reply?: ChannelReplyContext;
    mentions?: ChannelMention[];
    attachments?: ChannelAttachment[];
    text: string;
    threadId?: string;
    chatId: string;
    senderName?: string;
    senderId: string;
    messageId?: string;
    chatType?: ChannelChatType;
    channel: ChannelId;
};
export type OutgoingPart = {
    kind: "text";
    text: string;
} | {
    kind: "image";
    url?: string;
    filePath?: string;
    caption?: string;
} | {
    kind: "audio";
    filePath: string;
    mime: string;
} | {
    kind: "file";
    filePath: string;
    name?: string;
    mime?: string;
} | {
    kind: "video";
    filePath: string;
    name?: string;
    mime?: string;
} | {
    kind: "card";
    title: string;
    markdown?: string;
    fields?: Array<{
        key: string;
        value: string;
    }>;
} | {
    kind: "sticker";
    stickerId: string;
    imagePath: string;
};
export type OutgoingMessage = {
    parts: OutgoingPart[];
    replyContext?: {
        messageId: string;
        mentionUserId?: string;
    };
    threadId?: string;
    targetId: string;
    chatType?: ChannelChatType;
    channel: ChannelId;
};
export type ChannelStatus = {
    detail?: Record<string, unknown>;
    message?: string;
    phase: "running" | "offline" | "starting" | "config_missing" | "error";
    enabled: boolean;
};
export type MessageHandler = (msg: IncomingMessage) => Promise<OutgoingMessage | null>;
export type InboundRouteContext = {
    broadcastChat?: (event: {
        type: "bot:message";
        payload: unknown;
    }) => void;
    chatWindow?: WebContents | null;
};
