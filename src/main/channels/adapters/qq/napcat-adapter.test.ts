import { it, expect } from "vitest";
import { splitQqText, isQqEventAllowed } from "./napcat-adapter";
import type { QqChannelConfig } from "../../settings-store";

const policy: QqChannelConfig = {
  enabled: true, listenMode: "loopback", port: 6200, allowedPrivateUserIds: ["31415"], allowedGroupIds: ["27182"],
  groupRequireMention: true, groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal",
};

it("allows only approved private senders and approved groups mentioning the bot", () => {
  const event = { user_id: "31415", message: [] };
  expect(isQqEventAllowed({ ...event, message_type: "private" }, policy, "16180")).toEqual(true);
  expect(isQqEventAllowed({ ...event, message_type: "private", user_id: "31416" }, policy, "16180")).toEqual(false);
  const group = { ...event, user_id: "31416", message_type: "group", group_id: "27182" };
  expect(isQqEventAllowed(group, policy, "16180")).toEqual(false);
  expect(isQqEventAllowed({ ...group, message: [{ type: "at", data: { qq: "16180" } }] }, policy, "16180")).toEqual(true);
});

it("splits at the 1500-codepoint boundary without corrupting astral characters", () => {
  const text = "海".repeat(1499) + "！" + "🪁".repeat(12);
  const chunks = splitQqText(text);
  expect(chunks.length).toEqual(2);
  expect([...chunks[0]].length).toEqual(1500);
  expect(chunks.join("")).toEqual(text);
});
