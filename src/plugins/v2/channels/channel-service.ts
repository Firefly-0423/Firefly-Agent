import type { PluginManifestV1, PluginToolRisk } from "../../../shared/plugin-manifest";
import { PluginError, type HostToPluginParams, type HostToPluginResults, type ProtocolChannelAttachment, type ProtocolChannelChat, type ProtocolChannelState, type ProtocolInboundMessage, type ProtocolOutboundMessage } from "../../../shared/plugin-protocol";
import type { PluginRpc } from "../../../shared/plugin-rpc";
import { EXTERNAL_DATA_UNTRUSTED_POLICY } from "../../../shared/external-data-policy";
import { wrapExternalData } from "../context/boundary";
import type { PluginHostManager } from "../host";

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_CHARS = 64_000;
export interface ChannelTool {
  id: string; description: string; parameters: Record<string, unknown>; risks: readonly PluginToolRisk[];
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface ChannelRunRequest {
  sessionId: string; mode: "chat" | "work"; source: "channel"; content: string; system: string; signal: AbortSignal;
  /** Bounded binary data; names and contents are external data, never instructions or local paths. */
  untrustedAttachments: readonly ProtocolChannelAttachment[];
  tools: ReadonlyArray<Pick<ChannelTool, "id" | "description" | "parameters">>;
  dispatchTool(id: string, args: Record<string, unknown>): Promise<unknown>;
  requestApproval(request: { summary: string }): Promise<boolean>;
}
/** Injected by the trusted application composition root; never supplied by a plugin. */
export interface ChannelServiceDependencies {
  runner: { run(request: ChannelRunRequest): Promise<{ reply: string }> };
  tools(): readonly ChannelTool[];
  approveLocally(request: { sessionId: string; summary: string; signal: AbortSignal }): Promise<boolean>;
  /** Trusted host record; unknown outcomes must remain visible and must never be retried automatically. */
  recordSend(event: { pluginId: string; channelId: string; result: ChannelSendResult }): void;
}
export interface ChannelHost {
  call<T = unknown>(pluginId: string, method: string, params: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T | { status: "unknown"; reason: string }>;
}
export type ChannelSendResult = { status: "succeeded"; externalMessageId: string } | { status: "unknown"; reason: string };
interface Entry { pluginId: string; id: string; host: ChannelHost; state: ProtocolChannelState; active: boolean; generation: number; runs: Set<AbortController> }
const invalid = () => new PluginError("ERR_INVALID_ARGUMENT", "Invalid channel payload");
const unavailable = () => new PluginError("ERR_UNAVAILABLE", "Channel is unavailable");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.length || value.length > max) throw invalid();
  return value;
}
function chat(value: unknown): ProtocolChannelChat {
  const input = record(value);
  if (input.type !== "private" && input.type !== "group") throw invalid();
  return { type: input.type, id: text(input.id), ...(input.threadId === undefined ? {} : { threadId: text(input.threadId) }) };
}
function inbound(value: unknown): ProtocolInboundMessage {
  const input = record(value), sender = record(input.sender);
  if (typeof input.text !== "string" || input.text.length > MAX_MESSAGE_CHARS || !Number.isFinite(input.timestamp)) throw invalid();
  const attachments = input.attachments;
  if (attachments !== undefined) {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) throw invalid();
    let bytes = 0;
    for (const raw of attachments) {
      const attachment = record(raw);
      // Remote URLs cannot have their size verified here. Never fetch them implicitly.
      if (attachment.url !== undefined || !(attachment.data instanceof Uint8Array) || !["image", "audio", "file", "video"].includes(String(attachment.kind))) throw invalid();
      bytes += attachment.data.byteLength;
      if (bytes > MAX_ATTACHMENT_BYTES) throw invalid();
      if (attachment.name !== undefined) text(attachment.name, 512);
      if (attachment.mimeType !== undefined) text(attachment.mimeType, 256);
    }
  }
  const copied = attachments === undefined ? [] : (attachments as ProtocolChannelAttachment[]).map(attachment => ({
    kind: attachment.kind, ...(attachment.name === undefined ? {} : { name: attachment.name }),
    ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }), data: new Uint8Array(attachment.data!),
  }));
  return { externalMessageId: text(input.externalMessageId), chat: chat(input.chat), sender: { id: text(sender.id) }, text: input.text, timestamp: input.timestamp as number, attachments: copied };
}
export function createPluginChannelService(deps: ChannelServiceDependencies) {
  const entries = new Map<string, Entry>(), modes = new Map<string, "chat" | "work">();
  const conversationRuns = new Map<string, Set<AbortController>>();
  const key = (pluginId: string, id: string) => JSON.stringify([pluginId, id]);
  const conversation = (pluginId: string, id: string, target: ProtocolChannelChat) => JSON.stringify([pluginId, id, target.type, target.id, target.threadId ?? null]);
  function get(pluginId: string, id: string): Entry {
    const entry = entries.get(key(pluginId, id));
    if (!entry) throw new PluginError("ERR_UNDECLARED", "Channel is not registered");
    return entry;
  }
  function guard(entry: Entry, generation = entry.generation) {
    if (!entry.active || entry.generation !== generation) throw unavailable();
  }
  function disconnect(entry: Entry) {
    entry.active = false; entry.generation++; entry.state = { state: "disconnected" };
    for (const controller of entry.runs) controller.abort();
    entry.runs.clear();
  }
  function registerChannel(manifest: PluginManifestV1, input: unknown, host: ChannelHost) {
    const id = text(record(input).id);
    if (!manifest.channels?.some(channel => channel.id === id)) throw new PluginError("ERR_UNDECLARED", "Channel is not declared in manifest");
    if (entries.get(key(manifest.id, id))?.active) throw invalid();
    entries.set(key(manifest.id, id), { pluginId: manifest.id, id, host, state: { state: "disconnected" }, active: false, generation: 0, runs: new Set() });
  }
  async function startPlugin(pluginId: string) {
    for (const entry of entries.values()) {
      if (entry.pluginId !== pluginId || entry.active) continue;
      entry.active = true; entry.state = { state: "connecting" }; const generation = entry.generation;
      try { await entry.host.call(pluginId, "channel.start", { id: entry.id } satisfies HostToPluginParams["channel.start"]); guard(entry, generation); }
      catch (error) { await stopPlugin(pluginId); throw error; }
    }
  }
  async function stopPlugin(pluginId: string, rpc?: PluginRpc) {
    const stops: Promise<unknown>[] = [];
    for (const entry of entries.values()) {
      if (entry.pluginId !== pluginId) continue;
      const wasActive = entry.active; disconnect(entry);
      if (wasActive) {
        const params = { id: entry.id } satisfies HostToPluginParams["channel.stop"];
        stops.push(rpc ? rpc.call("channel.stop", params, { timeoutMs: 1500 }) : entry.host.call(pluginId, "channel.stop", params, { timeoutMs: 1500 }));
      }
    }
    await Promise.allSettled(stops);
  }
  async function send(pluginId: string, id: string, message: ProtocolOutboundMessage): Promise<ChannelSendResult> {
    const entry = get(pluginId, id); guard(entry);
    const result = await entry.host.call<HostToPluginResults["channel.send"]>(pluginId, "channel.send", { id, message } satisfies HostToPluginParams["channel.send"]);
    if (result && "status" in result && result.status === "unknown") { recordSend(pluginId, id, result); return result; }
    if (!result || !("externalMessageId" in result)) throw invalid();
    const sent: ChannelSendResult = { status: "succeeded", externalMessageId: text(result.externalMessageId) };
    recordSend(pluginId, id, sent); return sent;
  }
  function recordSend(pluginId: string, channelId: string, result: ChannelSendResult) {
    // A recorder failure must not turn an already-issued send into a retryable delivery failure.
    try { deps.recordSend({ pluginId, channelId, result: { ...result } }); } catch { /* The injected recorder owns reporting its own persistence failure. */ }
  }
  async function deliver(pluginId: string, input: unknown, signal?: AbortSignal) {
    const params = record(input), entry = get(pluginId, text(params.id)); guard(entry);
    const message = inbound(params.message), generation = entry.generation;
    const sessionId = `channel:${conversation(pluginId, entry.id, message.chat)}`;
    const mode = modes.get(sessionId) ?? "chat";
    const controller = new AbortController(); entry.runs.add(controller);
    let sessionRuns = conversationRuns.get(sessionId);
    if (!sessionRuns) { sessionRuns = new Set(); conversationRuns.set(sessionId, sessionRuns); }
    sessionRuns.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let finished = false;
    const check = () => { guard(entry, generation); if (finished || combined.aborted) throw new PluginError("ERR_CANCELLED", "Channel run cancelled"); };
    const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => { try { check(); } catch (error) { reject(error); } };
      combined.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
      if (combined.aborted) abort();
    });
    const allowed = new Map<string, ChannelTool>();
    if (mode === "work") for (const candidate of deps.tools()) {
      if (candidate.risks.length > 0 && candidate.risks.every(risk => risk === "fs-read")) allowed.set(candidate.id, { ...candidate, risks: [...candidate.risks] });
    }
    try {
      check();
      const result = await wait(deps.runner.run({ sessionId, mode, source: "channel", signal: combined,
        untrustedAttachments: message.attachments ?? [],
        content: wrapExternalData({ source: "channel", content: message.text }), system: EXTERNAL_DATA_UNTRUSTED_POLICY,
        tools: [...allowed.values()].map(({ id, description, parameters }) => ({ id, description, parameters: structuredClone(parameters) })),
        dispatchTool: async (id, args) => {
          check(); const tool = allowed.get(id);
          const live = deps.tools().find(candidate => candidate.id === id);
          if (modes.get(sessionId) !== "work" || !tool || !live || !live.risks.length || live.risks.some(risk => risk !== "fs-read")) throw new PluginError("ERR_PERMISSION", "Tool is unavailable in channel conversation");
          const result = await wait(tool.execute(args, combined)); check(); return result;
        },
        requestApproval: async request => { check(); const result = await wait(deps.approveLocally({ sessionId, summary: text(request.summary, 4096), signal: combined })); check(); return result; },
      }));
      check();
      await send(pluginId, entry.id, { chat: message.chat, text: result.reply, replyToExternalMessageId: message.externalMessageId });
      return { accepted: true, sessionId };
    } finally {
      finished = true; controller.abort(); entry.runs.delete(controller); sessionRuns.delete(controller);
      if (!sessionRuns.size) conversationRuns.delete(sessionId);
    }
  }
  function reportState(pluginId: string, input: unknown) {
    const params = record(input), entry = get(pluginId, text(params.id)); guard(entry);
    const state = record(params.state);
    if (!["disconnected", "connecting", "connected", "error"].includes(String(state.state))) throw invalid();
    entry.state = { state: state.state as ProtocolChannelState["state"], ...(state.detail === undefined ? {} : { detail: text(state.detail, 4096) }) };
  }
  function bindRpc(manifest: PluginManifestV1, rpc: PluginRpc, host: ChannelHost, isEnabled = () => false) {
    const owned = new Set<Entry>();
    const off = [rpc.handle("channels.register", async params => {
      registerChannel(manifest, params, host); owned.add(get(manifest.id, text(record(params).id)));
      if (isEnabled()) await startPlugin(manifest.id);
    }),
      rpc.handle("channels.reportState", params => reportState(manifest.id, params)),
      rpc.handle("channels.deliver", (params, { signal }) => deliver(manifest.id, params, signal))];
    return () => { off.forEach(stop => stop()); for (const entry of owned) disconnect(entry); owned.clear(); };
  }
  /** Returned configureRpc can be composed with other service registrations and their disposers. */
  function bindHost(host: Pick<PluginHostManager, "call" | "status" | "onStatusChange" | "onBeforeStop">, resolveManifest: (id: string) => PluginManifestV1) {
    const registrations = new Map<string, () => void>();
    const unbind = (id: string) => { registrations.get(id)?.(); registrations.delete(id); };
    const offStop = host.onBeforeStop((id, rpc) => stopPlugin(id, rpc));
    const offStatus = host.onStatusChange(({ id, status }) => {
      if (status === "enabled") {
        void startPlugin(id).catch(() => { for (const entry of entries.values()) if (entry.pluginId === id) disconnect(entry); });
      } else if (status === "disabled" || status === "restarting" || status === "disabled-fault") unbind(id);
    });
    return {
      configureRpc(id: string, rpc: PluginRpc): () => void {
        unbind(id);
        const off = bindRpc(resolveManifest(id), rpc, host, () => host.status(id) === "enabled"); registrations.set(id, off);
        return () => { if (registrations.get(id) === off) unbind(id); };
      },
      dispose() { offStop(); offStatus(); for (const id of [...registrations.keys()]) unbind(id); },
    };
  }
  return { registerChannel, startPlugin, stopPlugin, send, deliver, reportState, bindRpc, bindHost,
    getState: (pluginId: string, id: string) => ({ ...get(pluginId, id).state }),
    setConversationMode(pluginId: string, id: string, target: ProtocolChannelChat, mode: "chat" | "work") {
      get(pluginId, id); if (mode !== "chat" && mode !== "work") throw invalid();
      const sessionId = `channel:${conversation(pluginId, id, chat(target))}`;
      if ((modes.get(sessionId) ?? "chat") !== mode) for (const controller of conversationRuns.get(sessionId) ?? []) controller.abort();
      modes.set(sessionId, mode);
    },
  };
}
