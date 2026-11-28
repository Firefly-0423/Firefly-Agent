import { expect, it } from "vitest";
import type WebSocket from "ws";
import { OneBotActionClient, OneBotActionError } from "./onebot-action-client";
import type { OneBotStreamPacket } from "./onebot-types";

function connection(timeout?: number) {
  const requests: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
  const socket = { readyState: 1, send: (wire: string) => requests.push(JSON.parse(wire)) };
  const client = new OneBotActionClient(socket as unknown as WebSocket, timeout);
  const respond = (index: number, data: unknown) => client.handleResponse({ echo: requests[index].echo, data, retcode: 0, status: "ok" });
  return { client, requests, respond };
}
const delay = () => new Promise(resolve => setTimeout(resolve, 2));

it("routes responses by echo even when the server answers requests in reverse order", async () => {
  const { client, respond } = connection();
  const earlier = client.call("lookup_catalog");
  const later = client.call("lookup_status");
  respond(1, { revision: 19 });
  respond(0, { revision: 17 });
  await expect(earlier).resolves.toStrictEqual({ revision: 17 });
  await expect(later).resolves.toStrictEqual({ revision: 19 });
  expect(client.pendingCount).toEqual(0);
});

it("surfaces failed server actions as typed OneBot errors", async () => {
  const { client, requests } = connection();
  const response = client.call("missing_operation");
  client.handleResponse({ status: "failed", retcode: 1404, echo: requests[0].echo, data: null, wording: "operation unavailable" });
  await expect(response).rejects.toBeInstanceOf(OneBotActionError);
});

it("removes timed-out calls from its pending count", async () => {
  const { client } = connection(7);
  await expect(client.call("delayed_operation")).rejects.toThrow(/timeout: delayed_operation/);
  expect(client.pendingCount).toEqual(0);
});

it("rejects every outstanding request on disconnect", async () => {
  const { client } = connection();
  const requests = [client.call("catalog"), client.call("status")];
  client.rejectAll("transport ended");
  for (const request of requests) await expect(request).rejects.toThrow("transport ended");
  expect(client.pendingCount).toEqual(0);
});

it("awaits asynchronous chunk processing in order before resolving the terminal response", async () => {
  const { client, respond } = connection();
  const indexes: number[] = [];
  const complete = client.callStream("media_download", {}, async packet => {
    if (packet.index !== undefined) { await delay(); indexes.push(packet.index); }
  });
  respond(0, { type: "stream", data_type: "file_chunk", index: 4 });
  respond(0, { type: "stream", data_type: "file_chunk", index: 5 });
  respond(0, { type: "response", data_type: "file_complete" });
  await expect(complete).resolves.toMatchObject({ type: "response" });
  expect(indexes).toStrictEqual([4, 5]);
});

it("processes preceding packets and the reset callback before rejecting a stream reset", async () => {
  const { client, respond } = connection();
  const kinds: string[] = [];
  const complete = client.callStream("media_download", {}, async packet => { await delay(); kinds.push(packet.type); });
  respond(0, { type: "stream", data_type: "file_info" });
  respond(0, { type: "reset" });
  await expect(complete).rejects.toThrow("OneBot stream reset");
  expect(kinds).toStrictEqual(["stream", "reset"]);
});

it("retains a callback failure while consuming later packets without unhandled rejections", async () => {
  const { client, respond } = connection();
  const indexes: number[] = [];
  const complete = client.callStream("media_download", {}, packet => {
    if (packet.index !== undefined) indexes.push(packet.index);
    if (packet.index === 5) throw new Error("cannot persist packet");
  });
  for (const index of [4, 5, 6]) respond(0, { type: "stream", data_type: "file_chunk", index });
  respond(0, { type: "response", data_type: "file_complete" });
  await expect(complete).rejects.toThrow("cannot persist packet");
  expect(indexes).toStrictEqual([4, 5, 6]);
  expect(client.pendingCount).toEqual(0);
});

it("reports the first callback error rather than a later server reset", async () => {
  const { client, respond } = connection();
  const complete = client.callStream("media_download", {}, (packet: OneBotStreamPacket) => {
    if (packet.data_type === "file_info") throw new Error("metadata callback refused");
  });
  respond(0, { type: "stream", data_type: "file_info" });
  respond(0, { type: "reset" });
  await expect(complete).rejects.toThrow("metadata callback refused");
});
