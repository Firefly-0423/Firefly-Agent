// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { SPECIALIST_AGENTS, type AgentRoutingView } from "../../../shared/specialist-agents";
import { loadAgentRoutingPanel } from "./agent-routing";
import { getAgentRoutingView } from "../../../main/settings/agent-model-routing";

it("distinguishes equal saved model labels without exposing service addresses or credentials", async () => {
  const root = document.createElement("div");
  const view = getAgentRoutingView({ modelProfiles: ["local-first", "local-second"].map(id => ({
    id, displayName: "Same name", provider: "fixture", model: "same-model",
    baseUrl: `http://127.0.0.1/${id}?private=value`, apiKey: "private-key",
  })) });
  await loadAgentRoutingPanel(root, { getAgentRouting: async () => view });
  const options = [...root.querySelectorAll('[data-routing-id="review"] option')]
    .filter(option => (option as HTMLOptionElement).value);
  expect(options.map(option => option.textContent)).toEqual(["Same name [local-first]", "Same name [local-second]"]);
  expect(root.textContent).not.toMatch(/127\.0\.0\.1|private=value|private-key/);
});

it("renders twelve agents and saves only one selected identity through the bridge", async () => {
  const root = document.createElement("div");
  const view: AgentRoutingView = {
    profiles: [{ id: "fixture-model", label: "Public local fixture" }],
    routes: [{ id: "reasoning" }],
    agents: SPECIALIST_AGENTS.map(agent => ({ ...agent, error: "AGENT_MODEL_ROUTE_UNCONFIGURED" })),
  };
  const updateAgentRouting = vi.fn(async () => view);
  await loadAgentRoutingPanel(root, { getAgentRouting: async () => view, updateAgentRouting });
  expect(root.querySelectorAll('[data-routing-kind="agent"]')).toHaveLength(12);
  expect(root.querySelectorAll('[data-routing-kind="route"]')).toHaveLength(0);
  // 每个角色都带一句简介，且来自共享定义而不是 description（后者是给模型看的职责说明）
  const intros = [...root.querySelectorAll(".agent-routing-intro")].map(node => node.textContent);
  expect(intros).toEqual(SPECIALIST_AGENTS.map(agent => agent.intro));
  expect(SPECIALIST_AGENTS.every(agent => agent.intro.length > 0 && agent.intro !== agent.description)).toBe(true);
  // 界面不再露出原始错误码；原始码保留在 title 里供悬停查看
  expect(root.textContent).not.toContain("AGENT_MODEL_ROUTE_UNCONFIGURED");
  const refused = root.querySelector<HTMLElement>('[data-routing-state="error"]')!;
  expect(refused.textContent).toBe("还没有默认模型 · 将拒绝执行");
  expect(refused.title).toBe("AGENT_MODEL_ROUTE_UNCONFIGURED");
  const select = root.querySelector<HTMLSelectElement>('[data-routing-id="review"]')!;
  select.value = "fixture-model";
  select.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(updateAgentRouting).toHaveBeenCalledWith({ kind: "agent", id: "review", profileId: "fixture-model" }));
  expect(root.querySelectorAll('input[type="password"]')).toHaveLength(0);
});

it("retains the selection and displays save failure without claiming success", async () => {
  const root = document.createElement("div");
  const view: AgentRoutingView = { profiles: [{ id: "fixture", label: "Fixture" }], routes: [], agents: SPECIALIST_AGENTS.map(agent => ({ ...agent })) };
  await loadAgentRoutingPanel(root, { getAgentRouting: async () => view, updateAgentRouting: async () => { throw new Error("write blocked"); } });
  const select = root.querySelector<HTMLSelectElement>("select")!;
  select.value = "fixture";
  select.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(root.textContent).toContain("write blocked"));
  expect(select.value).toBe("fixture");
  expect(select.disabled).toBe(false);
});


it("announces a saved routing choice and restores focus to its replacement control", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const view: AgentRoutingView = { profiles: [{ id: "fixture", label: "Fixture" }], routes: [], agents: SPECIALIST_AGENTS.map(agent => ({ ...agent })) };
  await loadAgentRoutingPanel(root, { getAgentRouting: async () => view, updateAgentRouting: async () => ({ ...view, agents: view.agents.map(agent => ({ ...agent, overrideProfileId: "fixture", effectiveProfileId: "fixture" })) }) });
  const select = root.querySelector<HTMLSelectElement>('[data-routing-id="review"]')!;
  select.focus();
  select.value = "fixture";
  select.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(root.querySelector('[data-routing-id="review"]')).not.toBe(select));
  expect(document.activeElement).toBe(root.querySelector('[data-routing-id="review"]'));
  expect(root.querySelector('[role="status"]')?.textContent).toBeTruthy();
  root.remove();
});

it("keeps one pending routing write even if a second change event arrives", async () => {
  const root = document.createElement("div");
  const view: AgentRoutingView = { profiles: [{ id: "fixture", label: "Fixture" }], routes: [], agents: SPECIALIST_AGENTS.map(agent => ({ ...agent })) };
  let finish!: (view: AgentRoutingView) => void;
  const update = vi.fn(() => new Promise<AgentRoutingView>(resolve => { finish = resolve; }));
  await loadAgentRoutingPanel(root, { getAgentRouting: async () => view, updateAgentRouting: update });
  const select = root.querySelector<HTMLSelectElement>('select')!;
  select.value = "fixture";
  select.dispatchEvent(new Event("change"));
  select.dispatchEvent(new Event("change"));
  expect(root.getAttribute("aria-busy")).toBe("true");
  expect(update).toHaveBeenCalledTimes(1);
  finish(view);
  await vi.waitFor(() => expect(root.getAttribute("aria-busy")).toBe("false"));
});

it("presents one primary role state and keeps configuration source in inspectable details", async () => {
  const root = document.createElement("div");
  const view: AgentRoutingView = { profiles: [{ id: "fixture", label: "Fixture" }], routes: [], agents: SPECIALIST_AGENTS.slice(0, 3).map((agent, i) => ({ ...agent, effectiveProfileId: "fixture", ...(i === 0 ? { error: "AGENT_MODEL_PROFILE_NOT_FOUND", overrideProfileId: "missing" } : i === 1 ? { overrideProfileId: "fixture" } : {}) })) };
  await loadAgentRoutingPanel(root, { getAgentRouting: async () => view });
  const rows = [...root.querySelectorAll('label')];
  expect(rows.map(row => row.querySelector('[data-routing-state]')?.getAttribute('data-routing-state'))).toEqual(["error", "independent", "inherited"]);
  expect(rows[0].querySelector('[data-routing-state]')?.textContent?.match(/AGENT_MODEL_PROFILE_NOT_FOUND/g)).toHaveLength(1);
  for (const row of rows) {
    expect(row.querySelector('details summary')).not.toBeNull();
    expect(row.querySelector('details')?.textContent).toContain("fixture");
  }
});


it("localizes routing states and source inspection in English", async () => {
  const { setLocale } = await import("../i18n");
  setLocale("en");
  try {
    const root = document.createElement("div");
    const view: AgentRoutingView = { profiles: [{ id: "fixture", label: "Fixture" }], routes: [], agents: [{ ...SPECIALIST_AGENTS[0], effectiveProfileId: "fixture" }] };
    await loadAgentRoutingPanel(root, { getAgentRouting: async () => view });
    expect(root.querySelector('[data-routing-state]')?.textContent).toBe("Follows the default model · Fixture");
    expect(root.querySelector('details summary')?.textContent).toBe("Configuration source");
    expect(root.querySelector('option')?.textContent).toBe("Follow the default model");
  } finally { setLocale("zh-CN"); }
});

it("shows the unconfigured route as a friendly refusal state instead of the raw error code", async () => {
  const root = document.createElement("div");
  const view: AgentRoutingView = { profiles: [], routes: [], agents: [{ ...SPECIALIST_AGENTS[0], error: "AGENT_MODEL_ROUTE_UNCONFIGURED" }] };
  await loadAgentRoutingPanel(root, { getAgentRouting: async () => view });
  const state = root.querySelector<HTMLElement>('[data-routing-state="error"]')!;
  expect(state.textContent).toBe("还没有默认模型 · 将拒绝执行");
  expect(state.title).toBe("AGENT_MODEL_ROUTE_UNCONFIGURED");
  expect(root.textContent).not.toContain("AGENT_MODEL_ROUTE_UNCONFIGURED");
});

it("gives every role a round avatar: its portrait when one exists, an initial placeholder otherwise", async () => {
  const root = document.createElement("div");
  const view: AgentRoutingView = {
    profiles: [],
    routes: [],
    agents: [...SPECIALIST_AGENTS, { ...SPECIALIST_AGENTS[0], id: "no-portrait", nickname: "无立绘" }],
  };
  await loadAgentRoutingPanel(root, { getAgentRouting: async () => view });
  const avatars = [...root.querySelectorAll<HTMLElement>(".agent-routing-avatar")];
  expect(avatars).toHaveLength(SPECIALIST_AGENTS.length + 1);
  for (const avatar of avatars.slice(0, SPECIALIST_AGENTS.length)) {
    expect(avatar.querySelector("img")).not.toBeNull();
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
  }
  const placeholder = avatars.at(-1)!;
  expect(placeholder.querySelector("img")).toBeNull();
  expect(placeholder.dataset.placeholder).toBe("true");
  expect(placeholder.textContent).toBe("无");
});

it("names a saved route binding as the source instead of claiming the role follows the default", async () => {
  const root = document.createElement("div");
  const view = getAgentRoutingView({
    modelProfiles: ["local-default", "local-route"].map(id => ({ id, displayName: id, provider: "fixture", model: id, baseUrl: "http://127.0.0.1", apiKey: "" })),
    defaultModelProfileId: "local-default",
    agentModelProfiles: { reasoning: "local-route" },
  });
  await loadAgentRoutingPanel(root, { getAgentRouting: async () => view });
  const bound = SPECIALIST_AGENTS.find(agent => agent.modelProfile === "reasoning")!;
  const free = SPECIALIST_AGENTS.find(agent => agent.modelProfile !== "reasoning")!;
  const state = (id: string) => root.querySelector<HTMLElement>(`#routing-state-${id}`)!;
  expect(state(bound.id).dataset.routingState).toBe("route");
  expect(state(bound.id).textContent).toBe("跟随角色路由 · local-route");
  expect(state(free.id).dataset.routingState).toBe("inherited");
  expect(state(free.id).textContent).toBe("跟随默认模型 · local-default");
});
