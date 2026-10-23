export type OneBotSegment = {
    data: Record<string, unknown>;
    type: string;
};
export type OneBotSender = {
    card?: string;
    nickname?: string;
    user_id?: string | number;
};
export type OneBotMessageEvent = {
    raw_message?: string;
    message: OneBotSegment[];
    sender?: OneBotSender;
    group_id?: string | number;
    user_id: string | number;
    message_id: string | number;
    message_type: "private" | "group";
    post_type: "message" | "message_sent";
    self_id: string | number;
    time?: number;
};
export type OneBotMetaEvent = {
    meta_event_type?: string;
    post_type: "meta_event";
    self_id?: string | number;
    time?: number;
};
export type OneBotEvent = OneBotMessageEvent | OneBotMetaEvent | Record<string, unknown>;
export type OneBotResponse<T = unknown> = {
    stream?: "normal-action" | "stream-action" | string;
    echo?: string;
    wording?: string;
    message?: string;
    data: T;
    retcode: number;
    status: "ok" | "failed" | string;
};
export type OneBotStreamPacket = {
    received_chunks?: number;
    sha256?: string;
    file_path?: string;
    status?: string;
    stream_id?: string;
    total_bytes?: number;
    total_chunks?: number;
    progress?: number;
    size?: number;
    data?: string;
    index?: number;
    chunk_size?: number;
    file_size?: number;
    file_name?: string;
    data_type?: string;
    type: "stream" | "response" | "reset" | "error";
};
export type OneBotLoginInfo = {
    nickname?: string;
    user_id: string | number;
};
export type OneBotVersionInfo = {
    protocol_version?: string;
    app_version?: string;
    app_name?: string;
};
export function oneBotId(value: unknown): string {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
export function isOneBotMessageEvent(value: unknown): value is OneBotMessageEvent {
    if (!value || typeof value !== "object")
        return false;
    const event = value as Partial<OneBotMessageEvent>;
    return (event.post_type === "message" || event.post_type === "message_sent")
        && (event.message_type === "private" || event.message_type === "group")
        && Array.isArray(event.message);
}
