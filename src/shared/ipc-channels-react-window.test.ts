import { expect, it } from "vitest";
import { IPC } from "./ipc-channels";

it("publishes the React window handshake and navigation wire names", () => {
  expect([IPC.CHATS_REACT_READY, IPC.CHATS_OPEN_IN_REACT_WINDOW, IPC.CHATS_REACT_SWITCH_SESSION])
    .toStrictEqual(["chats:react-ready", "chats:open-in-react-window", "chats:react-switch-session"]);
});

it.each(["CHATS_SWITCH_SESSION", "CHATS_OPEN_IN_CHAT_WINDOW"])("does not advertise retired key %s", key => {
  expect(IPC).not.toHaveProperty(key);
});