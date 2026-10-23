import { it, expect, vi } from "vitest";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { IncomingMessage, OutgoingMessage } from "../../types";

vi.mock("electron", () => ({ app: { getPath: () => process.env.TEMP ?? process.cwd() } }));
vi.mock("../../settings-store", () => ({
  loadChannelsSettings: () => ({ qq: {
    enabled: true, listenMode: "loopback", port: 0, allowedPrivateUserIds: ["31415"], allowedGroupIds: ["27182", "27183"],
    groupRequireMention: true, groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal",
  } }),
}));
import { NapCatAdapter } from "./napcat-adapter";

const pause = (duration = 5) => new Promise(resolve => setTimeout(resolve, duration));
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("NapCat contract did not reach the expected state");
    await pause();
  }
}

it("completes the reverse-WS handshake, filters incoming events and preserves reply order", async () => {
  const adapter = new NapCatAdapter();
  let socket: WebSocket | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await adapter.start();
    socket = new WebSocket(String(adapter.getConnectionInfo().listenUrl), { headers: { "X-Self-ID": "16180" } });
    const commands: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
    socket.on("message", bytes => {
      const request = JSON.parse(bytes.toString());
      commands.push(request);
      const responses: Record<string, unknown> = {
        get_login_info: { user_id: "16180", nickname: "Contract bot" },
        get_version_info: { app_name: "NapCat", app_version: "4.9.122", protocol_version: "v11" },
        get_status: { online: true, good: true },
      };
      socket!.send(JSON.stringify({ echo: request.echo, status: "ok", retcode: 0,
        data: responses[request.action] ?? { message_id: `receipt-${commands.length}` } }));
    });
    await once(socket, "open");
    await until(() => adapter.getStatus().phase === "running");
    const identity = { selfId: "16180", nickname: "Contract bot", appVersion: "4.9.122", supportsStream: true };
    expect(adapter.getConnectionInfo()).toMatchObject(identity);
    await expect(adapter.testConnection()).resolves.toMatchObject({ detail: identity, ok: true });

    const received: IncomingMessage[] = [];
    adapter.onMessage = async incoming => {
      received.push(incoming);
      const reply: OutgoingMessage = {
        channel: "qq", targetId: incoming.chatId, chatType: incoming.chatType,
        replyContext: incoming.chatType === "group" ? { messageId: incoming.messageId!, mentionUserId: incoming.senderId } : undefined,
        parts: [{ kind: "text", text: `Acknowledged: ${incoming.text}` }, ...(incoming.chatType === "group" ? [{ kind: "text" as const, text: "Review continues" }] : [])],
      };
      await adapter.send(reply);
      return reply;
    };
    const group = {
      time: 1_750_000_000, self_id: "16180", post_type: "message", message_type: "group", message_id: "group-review",
      user_id: "31415", group_id: "27182", sender: { user_id: "31415", card: "Review lead" },
      message: [{ type: "at", data: { qq: "16180" } }, { type: "text", data: { text: "Begin review" } }],
    };
    const send = (event: unknown) => socket!.send(JSON.stringify(event));
    const groupCommands = () => commands.filter(command => command.action === "send_group_msg");
    send(group);
    await until(() => groupCommands().length === 2);
    expect(groupCommands()[0].params.group_id).toEqual("27182");
    expect(groupCommands()[0].params.message).toStrictEqual([
      { type: "reply", data: { id: "group-review" } }, { type: "at", data: { qq: "31415" } },
      { type: "text", data: { text: " " } }, { type: "text", data: { text: "Acknowledged: Begin review" } },
    ]);
    expect(groupCommands()[1].params.message).toStrictEqual([{ type: "text", data: { text: "Review continues" } }]);

    send(group);
    send({ ...group, message_id: "no-mention", message: [{ type: "text", data: { text: "Do not answer" } }] });
    await pause(30);
    expect(groupCommands()).toHaveLength(2);

    send({ ...group, message_type: "private", message_id: "private-review", group_id: undefined,
      message: [{ type: "text", data: { text: "Private review" } }] });
    await until(() => commands.some(command => command.action === "send_private_msg"));
    expect(commands.find(command => command.action === "send_private_msg")?.params).toMatchObject({
      user_id: "31415", message: [{ type: "text", data: { text: "Acknowledged: Private review" } }],
    });
    send({ ...group, message_type: "private", message_id: "private-unapproved", user_id: "31416", group_id: undefined,
      message: [{ type: "text", data: { text: "Unapproved sender" } }] });
    await pause(30);
    expect(received).toHaveLength(2);

    const handedOff: string[] = [];
    adapter.onMessage = async incoming => {
      handedOff.push(incoming.messageId!);
      if (incoming.messageId === "overlap-a") await gate;
      return null;
    };
    send({ ...group, message_id: "overlap-a" });
    send({ ...group, message_id: "overlap-b" });
    await until(() => handedOff.length === 2);
    expect(handedOff).toStrictEqual(["overlap-a", "overlap-b"]);
  } finally {
    release();
    socket?.terminate();
    await adapter.stop();
  }
});
