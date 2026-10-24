import React, { Profiler, type ProfilerOnRenderCallback } from "react";
import { createRoot } from "react-dom/client";
import "../ui/theme";
import { App } from "../react/App";
import { AppProviders } from "../react/app/providers/AppProviders";
import { initUiLocale } from "../react/i18n";
import { installFakeBridges } from "./fake-bridges";
import type { PerfDataset } from "./fixture";
import type { ChatPerfProbeCounters } from "../react/features/chat/components/chat-perf-probe";

interface HarnessParams {
  scrollMode: "bottom" | "top"; durationMs: number; seed: number; count: number; dataset: PerfDataset;
}
function parseParams(): HarnessParams {
  const query = new URLSearchParams(window.location.search);
  const chosenDataset = query.get("dataset");
  const requestedCount = Number(query.get("count") ?? 200);
  const requestedDuration = Number(query.get("duration") ?? 30_000);
  return {
    dataset: chosenDataset === "markdown" || chosenDataset === "mixed" ? chosenDataset : "plain",
    count: requestedCount === 0 || requestedCount === 500 ? requestedCount : 200,
    seed: Number(query.get("seed") ?? 42),
    durationMs: Math.min(120_000, Math.max(2_000, requestedDuration)),
    scrollMode: query.get("scroll") === "top" ? "top" : "bottom",
  };
}
function median(samples: number[]): number {
  if (samples.length === 0) return 0;
  const ascending = samples.slice().sort((left, right) => left - right);
  const center = Math.floor(ascending.length / 2);
  if (ascending.length % 2) return ascending[center]!;
  return (ascending[center - 1]! + ascending[center]!) / 2;
}
function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const ascending = samples.slice().sort((left, right) => left - right);
  const rank = Math.min(ascending.length - 1, Math.ceil(ascending.length * 0.95) - 1);
  return ascending[rank]!;
}
function stats(samples: number[]) {
  return {
    count: samples.length,
    median: Math.round(median(samples) * 100) / 100,
    p95: Math.round(p95(samples) * 100) / 100,
    max: samples.length ? Math.round(Math.max(...samples) * 100) / 100 : 0,
    total: Math.round(samples.reduce((accumulated, sample) => accumulated + sample, 0) * 100) / 100,
  };
}
const sleep = (milliseconds: number) => new Promise<void>((complete) => window.setTimeout(complete, milliseconds));
const configuration = parseParams();
interface CommitRecord { actualDuration: number; phase: string; atMs: number; }
const renderSamples: CommitRecord[] = [];
const taskSamples: Array<{ atMs: number; duration: number }> = [];
const frames: Array<{ atMs: number; delta: number }> = [];
const paintDelays: number[] = [];
const heapReadings: number[] = [];
let beganAt = 0;
let endedAt = 0;
let stage: "booting" | "hydrated" | "streaming" | "done" = "booting";
let receivedAt: number | null = null;
let measuredEventAt = 0;
let previousFrame: number | null = null;
let stopFrames = false;
let observedProbe: ChatPerfProbeCounters | null = null;
const shellSnapshot: ChatPerfProbeCounters = { markdownRenders: 0, navigationRenders: 0, sidebarRenders: 0, listRenders: 0 };
const shellChanges: Array<{ atMs: number; sinceStreamStartMs: number | null; key: keyof ChatPerfProbeCounters; count: number; phase: string }> = [];
const arrivals: Array<{ atMs: number; type: string }> = [];
const diagnosticsWindow = window as typeof window & {
  __fireflyChatPerfProbe?: ChatPerfProbeCounters;
  __perfDone?: unknown;
  __perfHydrated?: boolean;
  __perfState?: string;
};
diagnosticsWindow.__perfState = stage;
const onProfilerRender: ProfilerOnRenderCallback = (_identity, renderStage, elapsed) => {
  renderSamples.push({ atMs: performance.now(), phase: renderStage, actualDuration: elapsed });
};
function frameLoop() {
  if (stopFrames) return;
  const timestamp = performance.now();
  if (previousFrame !== null) frames.push({ atMs: timestamp, delta: timestamp - previousFrame });
  previousFrame = timestamp;
  if (receivedAt !== null && receivedAt > measuredEventAt) {
    paintDelays.push(timestamp - receivedAt);
    measuredEventAt = receivedAt;
  }
  if (observedProbe) {
    for (const counter of ["navigationRenders", "sidebarRenders"] as const) {
      const reading = observedProbe[counter];
      if (reading > shellSnapshot[counter]) {
        shellChanges.push({
          atMs: timestamp,
          sinceStreamStartMs: beganAt > 0 ? timestamp - beganAt : null,
          key: counter,
          count: reading,
          phase: stage,
        });
        shellSnapshot[counter] = reading;
      }
    }
  }
  window.requestAnimationFrame(frameLoop);
}
async function main() {
  const runtime = installFakeBridges({ dataset: configuration.dataset, count: configuration.count, seed: configuration.seed, durationMs: configuration.durationMs });
  const counters: ChatPerfProbeCounters = { markdownRenders: 0, navigationRenders: 0, sidebarRenders: 0, listRenders: 0 };
  diagnosticsWindow.__fireflyChatPerfProbe = counters;
  observedProbe = counters;
  runtime.onEmit((incoming) => {
    receivedAt = performance.now();
    arrivals.push({ atMs: receivedAt, type: incoming.type ?? "unknown" });
  });
  if ("PerformanceObserver" in window) {
    try {
      const watcher = new PerformanceObserver((batch) => {
        for (const task of batch.getEntries()) taskSamples.push({ atMs: task.startTime, duration: task.duration });
      });
      watcher.observe({ entryTypes: ["longtask"] } as PerformanceObserverInit);
    } catch { /* 失败时维持现有流程。 */ }
  }
  const memoryInfo = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const memoryTimer = memoryInfo ? window.setInterval(() => heapReadings.push(memoryInfo.usedJSHeapSize), 2_000) : undefined;
  window.requestAnimationFrame(frameLoop);
  await initUiLocale().catch(() => {});
  const host = document.getElementById("firefly-react-root");
  if (!host) throw new Error("Root element #firefly-react-root not found");
  const reactRoot = createRoot(host);
  reactRoot.render(<React.StrictMode><Profiler id="chat-page" onRender={onProfilerRender}><AppProviders><App /></AppProviders></Profiler></React.StrictMode>);

  const requiredBubbles = configuration.count;
  let firstMessageTime: number | null = null;
  let repetitions = 0;
  let previousCount = -1;
  const hydrationLimit = performance.now() + 60_000;
  while (performance.now() < hydrationLimit) {
    const messages = document.querySelector<HTMLElement>(".ff-message-list");
    const quantity = messages ? messages.querySelectorAll(".ff-message").length : 0;
    if (quantity > 0 && firstMessageTime === null) firstMessageTime = performance.now();
    if (quantity >= requiredBubbles && quantity === previousCount) {
      repetitions += 1;
      if (repetitions >= 4) break;
    } else repetitions = 0;
    previousCount = quantity;
    await sleep(100);
  }
  const hydrationTime = performance.now();
  const hydratedCounters = { ...counters };
  const hydratedNodeCount = document.getElementsByTagName("*").length;
  const hydratedHeap = memoryInfo ? memoryInfo.usedJSHeapSize : null;
  diagnosticsWindow.__perfHydrated = true;
  stage = "hydrated";
  diagnosticsWindow.__perfState = stage;
  await sleep(600);
  const messageList = document.querySelector<HTMLElement>(".ff-message-list");
  if (configuration.scrollMode === "top" && messageList) {
    messageList.scrollTop = 0;
    await sleep(300);
  }
  const composer = document.querySelector<HTMLTextAreaElement>(".ff-workspace-composer textarea");
  if (!composer) { finishWithError("未找到输入框，驱动失败"); return; }
  composer.focus();
  const writeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  writeValue?.call(composer, "性能基线测试消息");
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(150);
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const launchLimit = performance.now() + 15_000;
  while (runtime.getRunCalls() === 0 && performance.now() < launchLimit) await sleep(100);
  if (runtime.getRunCalls() === 0) { finishWithError("发送后 15s 内未观测到 agui.run 调用"); return; }
  stage = "streaming";
  diagnosticsWindow.__perfState = stage;
  beganAt = performance.now();
  const initialCounters = { ...counters };
  const streamLimit = beganAt + configuration.durationMs + 60_000;
  while (!runtime.isScriptFinished() && performance.now() < streamLimit) await sleep(200);
  await sleep(2_500);
  endedAt = performance.now();
  stage = "done";
  diagnosticsWindow.__perfState = stage;
  stopFrames = true;
  if (memoryTimer !== undefined) window.clearInterval(memoryTimer);
  const duringStream = (sample: { atMs: number }) => sample.atMs >= beganAt && sample.atMs <= endedAt;
  const streamRenders = renderSamples.filter(duringStream);
  const streamFrames = frames.filter(duringStream);
  const streamTasks = taskSamples.filter(duringStream);
  diagnosticsWindow.__perfDone = {
    ok: true,
    params: configuration,
    timings: {
      firstBubbleMs: firstMessageTime === null ? null : Math.round(firstMessageTime),
      hydratedMs: Math.round(hydrationTime),
      streamStartAt: Math.round(beganAt),
      streamEndAt: Math.round(endedAt),
      streamDurationMs: Math.round(endedAt - beganAt),
    },
    reactChannel: {
      profilerActive: renderSamples.length > 0,
      commitsDuringStreaming: {
        ...stats(streamRenders.map((sample) => sample.actualDuration)),
        commitCount: streamRenders.length,
        commitsPerSecond: streamRenders.length / Math.max(0.001, (endedAt - beganAt) / 1000),
      },
      probeAfterHydration: hydratedCounters,
      probeDeltaDuringStreaming: {
        markdownRenders: counters.markdownRenders - initialCounters.markdownRenders,
        navigationRenders: counters.navigationRenders - initialCounters.navigationRenders,
        sidebarRenders: counters.sidebarRenders - initialCounters.sidebarRenders,
        listRenders: counters.listRenders - initialCounters.listRenders,
      },
      probeDeltaDuringEventStream: (() => {
        const finalArrival = arrivals.length > 0 ? arrivals[arrivals.length - 1]!.atMs : endedAt;
        const withinEvents = (change: (typeof shellChanges)[number]) => change.atMs >= beganAt && change.atMs <= finalArrival;
        return {
          navigationRenders: shellChanges.filter((change) => change.key === "navigationRenders" && withinEvents(change)).length,
          sidebarRenders: shellChanges.filter((change) => change.key === "sidebarRenders" && withinEvents(change)).length,
        };
      })(),
      expectedDeltaEvents: runtime.script.deltaCount,
    },
    userChannel: {
      frameTimesOverall: stats(frames.map((sample) => sample.delta)),
      frameTimesDuringStreaming: stats(streamFrames.map((sample) => sample.delta)),
      longTasks: {
        ...stats(streamTasks.map((sample) => sample.duration)),
        countOver32ms: streamTasks.filter((sample) => sample.duration > 32).length,
        countOver100ms: streamTasks.filter((sample) => sample.duration > 100).length,
      },
      eventToPaint: stats(paintDelays),
    },
    memory: {
      heapUsedAfterHydrationBytes: hydratedHeap,
      heapUsedFinalBytes: heapReadings.length ? heapReadings[heapReadings.length - 1] : null,
      heapUsedMaxBytes: heapReadings.length ? Math.max(...heapReadings) : null,
      domNodeCountAfterHydration: hydratedNodeCount,
      domNodeCountFinal: document.getElementsByTagName("*").length,
    },
    diagnostics: { shellProbeEvents: shellChanges, eventTimeline: arrivals },
  };
}
function finishWithError(message: string) {
  stage = "done";
  diagnosticsWindow.__perfState = stage;
  stopFrames = true;
  diagnosticsWindow.__perfDone = { ok: false, error: message, params: configuration };
}
void main().catch((failure) => { finishWithError(`harness 异常: ${failure instanceof Error ? failure.message : String(failure)}`); });
