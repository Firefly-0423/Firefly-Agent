# Firefly-Agent usage notice and disclaimer

Revised 2026-11-14  
Maintainer hotaru  
The minors clause is a draft awaiting review by the maintainer.

## ① Project and character sources

Firefly-Agent is an experimental open-source desktop assistant and unofficial fan project. Honkai: Star Rail characters and related IP belong to HoYoverse / miHoYo. This project has no official affiliation, partnership or endorsement. The Live2D model “Firefly 流萤前瞻小人桌宠” is by 是依七哒. The project keeps the creator's permission record. Other asset sources are documented in the provenance records.

## ② License scope

Source code is provided under MIT. Use, modification and distribution must preserve the notices required by that license. Models, images, character IP and third-party components have their respective permissions. Commercial rights for source code follow the MIT text. Reusing the model outside Firefly requires permission from its creator. See the source documents below for full terms and asset boundaries.

## ③ User responsibilities

Confirm that you are authorized to use the devices, accounts, data and input materials involved. Follow applicable law, platform rules and third-party rights. Check generated content before sending, publishing, sharing or using it. Protect accounts and credentials and take responsibility for your actions. Obtain necessary authorization when handling other people's data.

## ④ Tools and authorization risks

Files, commands, browsers, plugins, Skills, MCP and delegated partners may read information, modify files, access networks or call external services. Persistent grants and broad permissions expand the scope of later operations. Check targets, scope and consequences before granting access. Disable tools and revoke grants as needed, and back up important workspaces. Current mode and channel boundaries follow.

| Context | Behavior and risks |
|---|---|
| Desktop Chat | AI output, character expression, local and external data risks apply. Capabilities depend on enabled tools and authorization. |
| Desktop Work | May modify files, execute tasks, use external services and delegate to partners. Approval depends on permissions and persistent grants. Some operations may execute directly. |
| Desktop Code | May run commands and change code. Check the workspace, commands and backups. Execution may cause irreversible changes. |
| Channel Chat | Disabling tools provides chat only. QQ and official QQ bot group chats enforce this policy. |
| Channel Work | Enabling tools for private chats currently selects Work with allow_all and direct execution. Remote users may read or write files and run commands. Desktop approval expectations do not apply to this path. |
| Channel Code | Current channel policy selects Chat / Work only. Switching the desktop to Code or binding context does not grant Code access to a channel. |

These Channel Work boundaries reflect the implementation on the revision date and will be revised when the planned restrictions land. Limit remote tool access to trusted identities.

## ⑤ Storage and external services

Settings, credentials, conversations, memory and logs may be stored locally. Current code resolves the production directory to `%APPDATA%\Firefly`. The planned 1.2.0 directory is `%APPDATA%\Firefly-1.2.0`, pending implementation by the startup isolation work. Validate 1.2.0 with a fresh independent test directory. Do not copy older data into that directory. Development launch defaults to an isolated directory in the repository. See the user guide.

Protect the device, backups and local access. Depending on configuration, conversations, attachments, retrieved content, tool results and recordings may be sent to model, chat platform, speech or other services under their respective data policies. Channel messages pass through their platforms. Context binding can share text context, and memory may enter model requests. Avoid providing sensitive information without authorization.

## ⑥ AI output and operational risks

AI may produce errors, fabrications, omissions or unsafe suggestions. Seek qualified professional judgment for important medical, legal or financial decisions. Independently verify irreversible actions such as deletion, overwriting, publication and payments. Maintain recovery and backup options.

## ⑦ Character expression and emotional boundaries

Models generate character behavior and anthropomorphic expressions. These expressions cannot establish genuine feelings or intent. Maintain real-world relationships, rest and independent judgment, and avoid excessive reliance. Companion interaction cannot take on the role of professional psychological support.

## ⑧ Conditions for minors (draft)

Minors must use the software with informed guardian consent and ongoing guidance. Guardians should help review content, service terms, privacy and costs. Minors must not independently enable direct remote tool execution, broad file or command permissions, or submit sensitive identity information about themselves or others. Guardians should limit usage time and review interactions. Stop use and seek real-world support if distress or signs of dependency arise. Final wording awaits review by hotaru.

## ⑨ Warranty and liability boundaries

The software is provided as is under MIT and may have defects, interruptions or data loss. MIT warranty exclusions and liability limitations apply to the extent permitted by applicable law. Responsibilities that cannot legally be excluded or limited remain governed by applicable law.

## ⑩ Terms and operational authorization

This notice explains usage risks. Specific file operations, command execution, external delivery and persistent grants must still follow the product's permission mechanisms and your specific authorization. Reading, installing or using the software cannot substitute for authorization required for these operations.

## ⑪ Rights disputes and handling

Rights holders may provide maintainer hotaru with evidence of ownership, affected file or version locations and the requested action. The private contact channel is 【待负责人填写：私密联系渠道】. Until a channel is published, avoid posting identity documents, unpublished permission records or other private materials in public Issues. Upon receiving materials, the maintainer checks sources and permissions, handles the content according to verified findings and requests additional information when necessary. Handling times remain to be supplied by the maintainer.

## ⑫ Redacted feedback

Use project GitHub Issues to report the version, system, reproduction steps, expected and actual results, and minimal redacted logs. Remove API keys, AppSecret, tokens, accounts, openid, real file paths, chat text and private attachment contents. Recheck screenshots, logs and sample files before submission. The repository README links to public feedback.

## ⑬ Sources, licenses and acknowledgements

hotaru maintains this project. Thanks to asset creators, upstream projects and contributors. The independently maintained engineering project records third-party and adapted content. Preserve each applicable copyright notice when distributing it.

- [Source license](../LICENSE)
- [Model and character asset permissions](../MODEL_LICENSE.md)
- [Third-party licenses, provenance and contributions](../THIRD_PARTY_NOTICES.md)
- [User guide in Chinese](./user-guide/index.md)
- [简体中文](./disclaimer.zh-CN.md)

Offline copies ship in `resources/docs/`. View the repository links above in a source checkout or the online repository.
