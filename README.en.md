<p align="center"><a href="./README.md">简体中文</a> · <b>English</b></p>

<p align="center">
  <img src="./assets/firefly.png" alt="Firefly avatar" width="160">
</p>

<p align="center">
  <a href="https://github.com/Firefly-0423/Firefly-Agent"><img src="https://img.shields.io/badge/GitHub-Firefly--Agent-24292f?style=flat&logo=github&logoColor=white" alt="GitHub repository" height="20"></a>
  <a href="https://github.com/Firefly-0423/Firefly-Agent/releases/latest"><img src="https://img.shields.io/github/v/release/Firefly-0423/Firefly-Agent?style=flat&label=Download&color=2f8f6b" alt="Download the latest release" height="20"></a>
  <a href="https://hotarufirefly.online"><img src="https://img.shields.io/badge/Try%20it%20online-hotarufirefly.online-5fe0c1?style=flat" alt="Try it online" height="20"></a>
  <img src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078D6?style=flat&logo=windows&logoColor=white" alt="Runs on Windows 10 / 11" height="20">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat" alt="MIT License" height="20"></a>
</p>

Have you ever wanted Firefly to live on your computer, chatting with you and helping you get things done?

Firefly-Agent is a Windows Live2D desktop companion featuring Firefly from Honkai: Star Rail. She talks with you, reads and writes files, changes code and runs commands, and splits work with 12 partners. You can see every step she takes and everything she needs you to approve.

## ✨ At a glance

- **Three modes**: Chat to talk, Work to move tasks forward, Code to change code. Each has its own prompts and tools.
- **12 partners**: in Work and Code, Firefly hands parts of a task to the partner best suited for it, runs them in parallel, then checks and combines the results.
- **Live2D companion**: Firefly stays on your desktop and changes expression as she works. Proactive chat is optional and restrained.
- **Local memory**: memory and history search live in SQLite on your machine, with the key protected by Windows DPAPI.
- **Asks before acting**: file writes, commands and network actions run under permission levels, need your approval and can be cancelled at any time.
- **Built-in browser**: manual and agent browsing are granted separately, and the agent only acts within the domains and actions you approve.
- **Many models**: Chat Completions, Anthropic Messages and Responses APIs, with switchable model profiles.
- **Extensions**: a Skills market, a plugin market and the [plugin SDK](./plugin-sdk/), MCP servers, and QQ, WeChat and Feishu channels, each turned on only when you want it.

## 🚀 Quick start

Download the installer from [Releases](https://github.com/Firefly-0423/Firefly-Agent/releases/latest). It needs Windows 10 / 11 (x64). On first launch, create a model profile in Settings with your own model service and credentials. To look around first, try the live demo at [hotarufirefly.online](https://hotarufirefly.online).

To run from source you need Node.js 24 or later and pnpm 12.10.1:

```powershell
pnpm install
pnpm exec install-electron
pnpm run dev
```

Read the [disclaimer](./legal/disclaimer.en.md) before use. Channel setup is in the [user guide](./docs/user-guide/index.md) (Chinese); packaging and the native helper build are in the [development guide](./docs/contributing/development.md).

## 🗂️ Project structure

### Main process

`src/main/` has seven layers. A layer may only import from its own layer or lower ones, and each layer has its own `AGENTS.md`.

| Layer | Responsibility |
| --- | --- |
| `base/` | Storage, logging, app identity and data directory, IPC registration |
| `platform/` | Settings, permissions and approvals, windows, speech, browser, Git, LSP |
| `model/` · `tooling/` · `conversation/` | Model access and prompts; tool contracts; conversation records |
| `knowledge/` · `memory/` | Document retrieval, study workspace, Skills; memory, recall and context |
| `agent/` | Main loop, built-in tools, MCP, partner delegation |
| `features/` | Feature entry points: chat, sessions, channels, scheduler, plugins |
| `app/` | Composition root: wires modules, runs startup and shutdown |

### UI and shared code

| Folder | Responsibility |
| --- | --- |
| `src/renderer/` | React UI, Live2D, online demo |
| `src/preload/` | Controlled IPC bridge |
| `src/plugins/` | Plugin system core |
| `src/shared/` | Contracts shared by main and renderer |
| `src/cli/` | Command-line entry |

### Other folders

| Folder | Responsibility |
| --- | --- |
| `native/` | Rust native helper: screenshots, history reading, workspace handles |
| `plugin-sdk/` · `examples/` | Plugin SDK and examples |
| `skills/` · `vendor/firefly-skills/` | Project Skills; third-party Skills |
| `prompts/` | Layered character prompts and world lore |
| `site/` | Promo website and online demo |
| `scripts/` · `docs/` | Build, packaging and verification scripts; design and development docs |

## 💬 Feedback and contact

- Questions and suggestions: [open an issue](https://github.com/Firefly-0423/Firefly-Agent/issues).
- Submit Skills to [firefly-skills](https://github.com/Firefly-0423/firefly-skills) and plugins to [firefly-plugins](https://github.com/Firefly-0423/firefly-plugins).

Please do not attach keys, private conversations or user data to an issue.

## 📖 About

Firefly-Agent is developed by hotaru. The first public version, 1.1.0, was released in October 2026.

- The full documentation starts at the [docs index](./docs/README.md); the architecture and each layer's responsibilities are in [AGENTS.md](./AGENTS.md).
- The development environment, pre-commit checks and branch rules are in the [development guide](./docs/contributing/development.md).
- Data stays on your machine in `%APPDATA%\Firefly-1.2.0` and never goes into Git or the installer. Conversations and documents may be sent to the model service you choose, so use only services you trust.

## ⚖️ License

- The source code is under the [MIT License](./LICENSE).
- Sources and licenses for third-party dependencies, Skills, models and images are in [THIRD_PARTY_NOTICES.md](./legal/THIRD_PARTY_NOTICES.md); the Live2D model license is in [MODEL_LICENSE.md](./legal/MODEL_LICENSE.md).
- Firefly and the related Honkai: Star Rail characters and intellectual property belong to HoYoverse / miHoYo and the respective rights holders. This is an unofficial, non-commercial fan project. Derivatives that contain the Firefly character, the Live2D model or character artwork may not be used commercially.

## ⭐ Support

If you like this project, a Star helps.
