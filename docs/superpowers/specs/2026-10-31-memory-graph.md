# Memory graph view

Status: draft for the owner, 2026-10-31. The owner asked for a memory visualization graph ("记忆可视化图") in place of the retired entity graph.

## Goal

In 设置 → 流萤记忆, show what Firefly remembers as a picture instead of a list: what it knows, where each piece came from, and what changed. Every node can be opened, and the existing actions (edit, forget, confirm, reject) work from the graph as they do from the list.

## What the data allows today

The panel state already carries, per fact (`FactView`):
- the category (`typed.legacyAttribute`: language, response-style, shell, address, preference, programming…);
- the assertion text and scope (global or a project name);
- the source session (`sourceRef.binding.sessionId`);
- the activation reason and the time it was recorded;
- whether it superseded an earlier fact.

Candidates waiting for confirmation carry the same shape. Since PR #12, empty placeholders no longer reach the panel.

What it does not carry: session titles. A source node would only show an id. Main has to add a title (the same way it already adds `projectName`). The title is decoration only: no transcript text, no ids beyond what the panel already gets.

Caveat: automatic memory currently only learns reply language and style, plus what the user confirms. On a typical profile the graph has a handful of fact nodes. It grows with what the user confirms. It does not invent relations.

## Design

Layout: rings around one centre, no new dependency.

- Centre: 你 (the user).
- Ring 1: categories that have at least one fact, for example 回复语言, 回复风格, Shell, 称呼, 偏好, 项目习惯.
- Ring 2: facts, under their category.
  - A confirmed fact is a solid node; a candidate waiting for confirmation is a dashed node.
  - A fact that was corrected keeps a faded node for the old value, joined to the new one by a "更正为" edge.
- Ring 3: sources. These are the conversations each fact was learned in. A project-scoped fact also links to a project node.
- Drawn as inline SVG with a deterministic radial layout, so the same memory always draws the same way. It uses the app's colour tokens and works in both themes.
- Pan and zoom with the wheel and drag. It is keyboard reachable: Tab moves between nodes, Enter opens one.

Interaction:
- Clicking a fact opens the same card as the list (edit, forget, or confirm/reject for a candidate).
- Clicking a source shows the conversation title and an "打开对话" button.
- Hovering highlights the node's chain: category → fact → source.
- A 列表 / 关系图 switch sits above the entries. The list stays the default.

Empty state: "流萤还没记住什么。你在对话里说过的偏好，确认后会出现在这里。"

## Changes

- Main:
  - `MemoryPanelState` facts and candidates gain an optional `sourceTitle`. Main resolves it best effort, like `projectName`, and never fails the panel over it.
  - The settings IPC whitelists the field, and a test checks no session id or transcript text leaks.
- Renderer (vanilla TS, like the rest of settings):
  - `src/renderer/settings/memory/graph-layout.ts`: pure layout, unit tested;
  - `graph-panel.ts`: SVG rendering and interaction, reusing the entries panel's actions;
  - the view switch.
- No new dependency and no change to how memory is learned or recalled.

## Open questions

1. Placement: inside 设置 → 流萤记忆 next to the list (proposed), or also a read-only view in the chat's overview cards?
2. Sources: show conversation nodes (needs the `sourceTitle` field above), or only categories and facts?
3. Layout: fixed rings (proposed, no dependency, stable), or a force-directed layout, which looks livelier but needs a dependency such as d3-force and moves on every open?
