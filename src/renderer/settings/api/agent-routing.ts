import type { AgentRoutingView, AgentRoutingUpdate } from "../../../shared/specialist-agents";
import { t } from "../i18n";
import { getCharacterAvatar } from "../../react/character-avatars";

/** 主进程 agent-model-routing 在路由未配置时抛出的错误码（逻辑判断用，不直接展示）。 */
const UNCONFIGURED_ROUTE_ERROR = "AGENT_MODEL_ROUTE_UNCONFIGURED";

interface RoutingBridge {
  getAgentRouting?: () => Promise<AgentRoutingView>;
  updateAgentRouting?: (input: AgentRoutingUpdate) => Promise<AgentRoutingView>;
}

export async function loadAgentRoutingPanel(root: HTMLElement, bridge: RoutingBridge): Promise<void> {
  root.textContent = t("settings.agentRouting.loading");
  root.setAttribute("aria-busy", "true");
  let pending = false;
  const render = (view: AgentRoutingView, savedId?: string, restoreFocus = false) => {
    root.replaceChildren();
    const notice = document.createElement("p");
    notice.textContent = t("settings.agentRouting.notice");
    root.append(notice);
    const status = document.createElement("p");
    status.className = "agent-routing-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = savedId ? t("settings.agentRouting.saved") : "";
    root.append(status);
    for (const agent of view.agents) {
      const label = document.createElement("label");
      label.className = "agent-routing-row";
      const avatar = document.createElement("span");
      avatar.className = "agent-routing-avatar";
      avatar.setAttribute("aria-hidden", "true");
      const portrait = getCharacterAvatar(agent.nickname);
      if (portrait) {
        const img = document.createElement("img");
        img.src = portrait;
        img.alt = "";
        img.width = 40;
        img.height = 40;
        img.draggable = false;
        avatar.append(img);
      } else {
        // 没有对应立绘的角色：圆形底色 + 首字占位。
        avatar.dataset.placeholder = "true";
        avatar.textContent = agent.nickname.charAt(0);
      }
      const identity = document.createElement("span");
      identity.className = "agent-routing-identity";
      const title = document.createElement("strong");
      title.textContent = `${agent.nickname} · ${agent.role}`;
      const state = document.createElement("span");
      // A role without its own choice may still sit on a saved route binding; only with neither does it follow the default.
      const routeBound = !agent.overrideProfileId && view.routes.some(route => route.id === agent.modelProfile && route.profileId);
      state.dataset.routingState = agent.error ? "error" : agent.overrideProfileId ? "independent" : routeBound ? "route" : "inherited";
      state.id = `routing-state-${agent.id}`;
      if (agent.error) {
        // 原始错误码只用于逻辑判断与悬停提示；界面展示友好文案。
        state.textContent = agent.error === UNCONFIGURED_ROUTE_ERROR ? t("settings.agentRouting.unconfiguredRefused") : agent.error;
        state.title = agent.error;
      } else {
        // Name the model the role actually runs on, so "follows the default" is concrete.
        const effective = view.profiles.find(profile => profile.id === agent.effectiveProfileId)?.label;
        state.textContent = effective
          ? t(`settings.agentRouting.${state.dataset.routingState}Model`, { model: effective })
          : t(`settings.agentRouting.${state.dataset.routingState}`);
      }
      const intro = document.createElement("span");
      intro.className = "agent-routing-intro";
      intro.textContent = agent.intro ?? "";
      identity.append(title, ...(agent.intro ? [intro] : []), state);
      const select = document.createElement("select");
      select.dataset.routingKind = "agent";
      select.dataset.routingId = agent.id;
      select.setAttribute("aria-label", title.textContent);
      select.setAttribute("aria-describedby", state.id);
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = t("settings.agentRouting.roleDefault");
      select.append(empty);
      for (const profile of view.profiles) {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.label;
        select.append(option);
      }
      if (agent.overrideProfileId && !view.profiles.some(profile => profile.id === agent.overrideProfileId)) {
        const stale = document.createElement("option");
        stale.value = agent.overrideProfileId;
        stale.textContent = t("settings.agentRouting.missingProfile", { id: agent.overrideProfileId });
        select.append(stale);
      }
      select.value = agent.overrideProfileId ?? "";
      const source = document.createElement("details");
      source.className = "agent-routing-source";
      const summary = document.createElement("summary");
      summary.textContent = t("settings.agentRouting.source");
      const sourceText = document.createElement("p");
      sourceText.textContent = t("settings.agentRouting.sourceDescription", {
        route: agent.modelProfile,
        selected: agent.overrideProfileId ?? t("settings.agentRouting.roleDefault"),
        effective: agent.effectiveProfileId ?? t("settings.agentRouting.unconfigured"),
      });
      source.append(summary, sourceText);
      select.addEventListener("change", async () => {
        if (pending) return;
        pending = true;
        const hadFocus = document.activeElement === select;
        const controls = [...root.querySelectorAll("select")];
        controls.forEach(control => { control.disabled = true; });
        root.setAttribute("aria-busy", "true");
        status.classList.remove("is-error");
        status.textContent = t("settings.agentRouting.saving");
        try {
          if (!bridge.updateAgentRouting) throw new Error(t("settings.agentRouting.saveUnavailable"));
          const saved = await bridge.updateAgentRouting({ kind: "agent", id: agent.id, profileId: select.value || null });
          const focusStillOwned = hadFocus && (document.activeElement === select || document.activeElement === document.body);
          render(saved, agent.id, focusStillOwned);
        } catch (error) {
          status.classList.add("is-error");
          status.textContent = t("settings.agentRouting.saveFailed", { error: error instanceof Error ? error.message : String(error) });
          controls.forEach(control => { control.disabled = false; });
        } finally {
          pending = false;
          root.setAttribute("aria-busy", "false");
        }
      });
      label.append(avatar, identity, select, source);
      root.append(label);
      if (restoreFocus && agent.id === savedId && !root.closest('[hidden], .is-hidden, [inert]')) select.focus();
    }
  };
  try {
    if (!bridge.getAgentRouting) throw new Error(t("settings.agentRouting.loadUnavailable"));
    render(await bridge.getAgentRouting());
  } catch (error) {
    root.textContent = t("settings.agentRouting.loadFailed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    root.setAttribute("aria-busy", "false");
  }
}
