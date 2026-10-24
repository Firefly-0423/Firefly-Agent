// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopAsrButton } from "./DesktopAsrButton";
const media = vi.hoisted(() => ({ stop: vi.fn(async () => {}), cancel: vi.fn() }));
vi.mock("./desktop-asr-audio", () => ({ openDictationMicrophone: vi.fn(async () => media) }));
let root: Root; let host: HTMLElement;
beforeEach(() => { vi.spyOn(document,"hasFocus").mockReturnValue(true); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host=document.createElement("div"); document.body.append(host); root=createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.desktopAsr; vi.clearAllMocks(); vi.restoreAllMocks(); });
async function click(label: string) { const button=[...host.querySelectorAll("button")].find(x => x.getAttribute("aria-label") === label); expect(button).toBeTruthy(); await act(async () => button!.click()); }
it("does not record on mount; explicit start/stop fills a draft and offers cancellation", async () => {
  const text: string[]=[]; const start=vi.fn(async () => ({ok:true as const})); window.desktopAsr={start,frame:async()=>({ok:true}),stop:async()=>({ok:true,text:"语音草稿"}),cancel:async()=>({ok:true})};
  await act(async () => root.render(createElement(DesktopAsrButton,{onText:value=>text.push(value)})));
  expect(start).not.toHaveBeenCalled(); await click("语音转文字"); expect(host.textContent).toContain("取消"); await click("停止并转写"); expect(text).toEqual(["语音草稿"]);
});
it("shows configuration errors and discards late text after conversation-key replacement", async () => {
  const text: string[]=[]; let resolve!: (value:any)=>void;
  window.desktopAsr={start:async()=>({ok:false,code:"unconfigured"}),frame:async()=>({ok:true}),stop:()=>new Promise(r=>resolve=r),cancel:async()=>({ok:true})};
  await act(async()=>root.render(createElement(DesktopAsrButton,{key:"session-a",onText:value=>text.push(value)})));
  await click("语音转文字"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("设置");
  window.desktopAsr.start=async()=>({ok:true}); await click("语音转文字"); await click("停止并转写");
  await act(async()=>root.render(createElement(DesktopAsrButton,{key:"session-b",onText:value=>text.push(value)})));
  await act(async()=>resolve({ok:true,text:"旧会话结果"})); expect(text).toEqual([]); expect(host.querySelector('[aria-label="语音转文字"]')).not.toBeNull();
});
it("keeps native permission prompts alive but cancels recording when switching windows", async () => {
  const { openDictationMicrophone } = await import("./desktop-asr-audio");
  let resolve!: (value: any) => void;
  vi.mocked(openDictationMicrophone).mockImplementationOnce(() => new Promise(r => { resolve=r; }));
  const cancel=vi.fn(async()=>({ok:true as const}));window.desktopAsr={start:async()=>({ok:true}),frame:async()=>({ok:true}),stop:async()=>({ok:true,text:"text"}),cancel};
  await act(async()=>root.render(createElement(DesktopAsrButton,{onText:()=>{}})));await click("语音转文字");
  await act(async()=>window.dispatchEvent(new Event("blur")));await act(async()=>resolve(media));
  expect(host.querySelector('[aria-label="停止并转写"]')).not.toBeNull();expect(cancel).not.toHaveBeenCalled();
  await act(async()=>window.dispatchEvent(new Event("blur")));expect(cancel).toHaveBeenCalledOnce();expect(host.querySelector('[aria-label="语音转文字"]')).not.toBeNull();
});
it("does not open or keep a microphone when a pending start completes in an unfocused window", async () => {
  const { openDictationMicrophone } = await import("./desktop-asr-audio");
  let resolve!: (value:any)=>void;const cancel=vi.fn(async()=>({ok:true as const}));
  window.desktopAsr={start:()=>new Promise(r=>resolve=r),frame:async()=>({ok:true}),stop:async()=>({ok:true}),cancel};
  await act(async()=>root.render(createElement(DesktopAsrButton,{onText:()=>{}})));await click("语音转文字");
  vi.mocked(document.hasFocus).mockReturnValue(false);await act(async()=>window.dispatchEvent(new Event("blur")));await act(async()=>resolve({ok:true}));
  expect(openDictationMicrophone).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();
});

it("revokes a replaced conversation before a layout-time late result settles", async () => {
  const text: string[] = [];
  let resolveStop!: (value: any) => void;
  let committedB = false;
  window.desktopAsr = { start: async () => ({ ok: true }), frame: async () => ({ ok: true }), stop: () => new Promise(resolve => { resolveStop = resolve; }), cancel: async () => ({ ok: true }) };
  function Owner({ id }: { id: string }) {
    useLayoutEffect(() => { if (id === "b") { committedB = true; resolveStop({ ok: true, text: "old transcript" }); } }, [id]);
    return createElement(DesktopAsrButton, { key: id, onText: value => text.push(`${id}:${value}`) });
  }
  await act(async () => root.render(createElement(Owner, { id: "a" })));
  await click("语音转文字"); await click("停止并转写");
  // act eagerly drains passive effects; exercise the actual commit → microtask ordering.
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  try {
    root.render(createElement(Owner, { id: "b" }));
    await vi.waitFor(() => expect(committedB).toBe(true));
    expect(text).toEqual([]);
  } finally { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; }
});
