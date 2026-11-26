<p align="center"><a href="./README.md">简体中文</a> · <b>English</b></p>

<p align="center">
  <img src="./assets/firefly.png" alt="Firefly avatar" width="160">
</p>

<p align="center">
  <a href="https://github.com/Firefly-0423/Firefly-Agent"><img src="https://img.shields.io/badge/GitHub-Firefly--Agent-24292f?style=flat&logo=github&logoColor=white" alt="GitHub repository" height="20"></a>
  <a href="https://gitcode.com/hotaru_wu/Firefly-Agent"><img src="https://img.shields.io/badge/GitCode-Firefly--Agent-d94336?style=flat" alt="GitCode repository" height="20"></a>
</p>

Firefly-Agent is a Windows desktop companion featuring Firefly from Honkai: Star Rail, built to chat with you and help finish real tasks on your PC.

## What It Can Do

- **Three modes**: Chat handles everyday conversation, Work moves general tasks forward, and Code inspects files, edits code, and runs commands.
- **Partner collaboration**: When a task gets busy, Firefly delegates sub-tasks to 12 partners in parallel and reviews everything when they return.
- **Live2D presence**: Firefly stays on your desktop, reacts with expressions as tasks progress, and supports optional, restrained check-ins.
- **Local memory**: Conversations and long-term memory stay on your machine in SQLite, while API keys and plugin secrets are encrypted by Windows.
- **Permission first**: Choose between read-only, ask-before-acting, and full-access levels, approve sensitive actions in clear prompts, and cancel at any time.
- **Built-in browser**: Keep manual browsing and agent actions separated, and retain active pages for background read-only observation when switching chats.
- **Multi-provider models**: Connect compatible chat and response APIs and switch profiles whenever you need.
- **Plugins and extensions**: Extend Firefly with SDK 1.2.0 plugins, Skills, MCP servers, and scheduled reminders; external chat channel UI will follow in 1.2.x.

## Download and Install

- **Requirements**: Windows 10 or 11 (64-bit).
- **Installer**: Download the latest release from [GitHub Releases](https://github.com/Firefly-0423/Firefly-Agent/releases/latest).
- **Online demo**: Preview the interface without installing at [hotarufirefly.online](https://hotarufirefly.online).
- **First setup**: Launch the app, open Settings, and add at least one model profile with your own endpoint and credentials.
- **Isolated data folder**: Version 1.2.0 keeps conversations, settings, and logs in `%APPDATA%\Firefly-1.2.0`. Existing 1.1.x data directories are never read, altered, or migrated.

Please read the [disclaimer](./docs/disclaimer.en.md) before using the app. Channel and data-directory guides are available in the [user guide](./docs/user-guide/index.md) (in Chinese).

## What's New in 1.2.0 and Known Limitations

### Highlights

- **Refreshed dark theme**: `firefly-dark` now uses neutral near-black surfaces paired with an emerald accent across chat, settings, and reminder toasts.
- **Redesigned plugin architecture**: Plugins run in isolated child processes with local folder/package import, explicit enable trust prompts, per-permission revocation, model rate limits, and sandboxed plugin windows. Legacy 0.x plugins are no longer supported.
- **Schedule proposal review**: Plugin-proposed tasks land in a pending confirmation area where you approve or reject them, with time-zone-aware cron schedules and one-click "Run now" when eligible.
- **Resilient task execution**: Work and Code runs keep finishing if you switch chats or refresh, support mid-run "Send Now" supplements, and let you answer approvals right from reminder toasts.
- **Focused permission tiers**: Simplified to three file access levels (read-only, ask for approval, and full access), with confirmed full-document reading for Office and PDF attachments in Code mode.

For detailed release notes, see [GitHub Releases](https://github.com/Firefly-0423/Firefly-Agent/releases) or `CHANGELOG.md` on the release branch.

### Known Limitations

- **No unattended run approvals in 1.2.0**: Plugin schedules that require shell, file-write, or input-control tools are rejected when you try to confirm or enable them, displaying a notice that unattended approval is not yet supported in 1.2.0. Previously confirmed tasks of this kind log a `skipped` run and pause recurring schedules instead of executing; full unattended approval is planned for 1.2.x.
- **External channel desktop UI in 1.2.x**: Core SDK 1.2.0 channel services are in place, while unified desktop channel wiring and setup UI will arrive in 1.2.x.

## Plugin Development

Start building 1.2.0 plugins with these guides:

- [Plugin SDK README](./plugin-sdk/README.md): Installation, minimal manifest + entry example, permissions, and local test host.
- [Plugin Development Guide](./docs/plugins/plugin-dev-guide.md): Manifest fields, full capability API reference, and tested code snippets.
- [Plugin Authoring Notes](./docs/plugins/plugin-authoring.md): Process isolation vs. trust boundary, risk rules, and catalog requirements.

Working reference plugins (weather lookup and daily reminder) are included under [plugin-sdk/examples](./plugin-sdk/examples/).

## Contributing and Source Setup

Building and running from source requires **Windows**, **Node.js 24+**, and **pnpm 12.10.1**.

```powershell
pnpm install --frozen-lockfile
pnpm exec install-electron
pnpm run dev
```

For full build instructions, packaging steps, and workflow conventions, see the [development guide](./docs/contributing/development.md) (in Chinese) and [development workflow](./docs/contributing/development-workflow.md), or browse the [documentation index](./docs/README.md).

## Feedback and Links

- Bug reports and feature requests: [GitHub Issues](https://github.com/Firefly-0423/Firefly-Agent/issues).
- Skills repository: [firefly-skills](https://github.com/Firefly-0423/firefly-skills).
- Plugin catalog repository: [firefly-plugins](https://github.com/Firefly-0423/firefly-plugins).

Please remove API keys, private chats, and local machine paths before sharing logs or opening an issue.

## License and Credits

- Source code is licensed under the [MIT License](./LICENSE).
- Third-party dependencies, bundled Skills, and historical provenance notices are documented in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
- The bundled Firefly Live2D model is used by permission from creator **是依七哒**; see [MODEL_LICENSE.md](./MODEL_LICENSE.md) for asset and character IP boundaries.
- Firefly and Honkai: Star Rail intellectual property belong to HoYoverse / miHoYo and respective rights holders. This is an unofficial, non-commercial fan project; commercial use of derivatives containing the character, Live2D model, or character artwork is prohibited.
