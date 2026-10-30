// 在线演示的固定内容：每种模式一段示例会话，以及发消息后按轮次播放的回复剧本。
// 回复不看用户写了什么，只按模式和轮次挑选；界面上也如实说明这一点。

import type { ChatMessage, ChatSession, ConversationMode, ToolFileChange } from "../../shared/chat-types";
import type { ToolRiskLevel } from "../../shared/permission-approval";

export type DemoLang = "zh" | "en";

export interface DemoTool {
  name: string;
  displayName: string;
  args: Record<string, unknown>;
  result: string;
  changes?: ToolFileChange[];
  /** The tool waits for the visitor to approve it, as the desktop app does for writes and commands. */
  approval?: { risk: ToolRiskLevel; description: string };
}

export interface DemoTurn {
  reasoning?: string;
  tools?: DemoTool[];
  answer: string;
  /** Context tokens after the turn, shown in the overview card. */
  contextTokens: number;
}

export const DEMO_WORKSPACE = { displayName: "firefly-demo-workspace", workspaceRoot: "C:/Demo/firefly-demo-workspace" };

const text = (lang: DemoLang, zh: string, en: string) => (lang === "zh" ? zh : en);

const mainRsDiff: ToolFileChange = {
  file: "src/main.rs", kind: "modified", insertions: 6, deletions: 1,
  diff: [
    { type: "hunk", text: "@@ -3,5 +3,10 @@ fn main() {" },
    { type: "context", text: "    let args: Vec<String> = std::env::args().collect();" },
    { type: "remove", text: "    let text = &args[1];" },
    { type: "add", text: "    let text = match args.get(1) {" },
    { type: "add", text: "        Some(text) => text," },
    { type: "add", text: "        None => {" },
    { type: "add", text: "            eprintln!(\"usage: glowfly <text>\");" },
    { type: "add", text: "            std::process::exit(2);" },
    { type: "add", text: "        }" },
    { type: "add", text: "    };" },
    { type: "context", text: "    println!(\"{:?}\", count(text));" },
  ],
};

export function demoSessions(lang: DemoLang, now: number): ChatSession[] {
  const message = (id: string, role: ChatMessage["role"], content: string, minutesAgo: number): ChatMessage =>
    ({ id, role, content, at: now - minutesAgo * 60_000 });
  const session = (id: string, mode: ConversationMode, title: string, messages: ChatMessage[], minutesAgo: number): ChatSession => ({
    id, mode, title, messages, identityId: null, schemaVersion: 1,
    createdAt: now - (minutesAgo + 30) * 60_000, updatedAt: now - minutesAgo * 60_000,
    ...(mode === "chat" ? {} : { workspaceBinding: { ...DEMO_WORKSPACE, boundAt: now - 60 * 60_000 } }),
  });
  return [
    session("demo-chat", "chat", text(lang, "和流萤聊聊天", "Chat with Firefly"), [
      message("demo-chat-1", "user", text(lang, "今天有点累，陪我说说话吧。", "Long day. Talk with me for a bit?"), 12),
      message("demo-chat-2", "model", text(lang,
        "好呀，开拓者。累的时候不用急着把事情都想清楚，先坐下来喝口水。\n\n想聊今天发生的事，还是随便聊点轻松的？我都在。",
        "Of course, Trailblazer. When you're tired you don't have to sort everything out at once. Sit down, have some water first.\n\nDo you want to talk about today, or just chat about something light? I'm here either way."), 11),
    ], 11),
    session("demo-work", "work", text(lang, "整理本周学习计划", "Plan this week's study"), [
      message("demo-work-1", "user", text(lang, "帮我把 notes 里的课程笔记整理成这周的学习计划。", "Turn my course notes in notes/ into a study plan for this week."), 40),
      message("demo-work-2", "model", text(lang,
        "读完了 `notes/` 里的 3 份笔记。下面是按难度排好的本周计划，每天留了一段复习时间：\n\n| 日期 | 内容 | 检查点 |\n| --- | --- | --- |\n| 周一 | 线性代数：特征值 | 做完 5 道习题 |\n| 周三 | 概率：条件概率 | 自测 10 分钟 |\n| 周五 | 复习 + 错题 | 错题清零 |",
        "I read the 3 notes in `notes/`. Here's this week's plan, ordered by difficulty, with a review slot each day:\n\n| Day | Topic | Checkpoint |\n| --- | --- | --- |\n| Mon | Linear algebra: eigenvalues | 5 exercises done |\n| Wed | Probability: conditional | 10-minute self-test |\n| Fri | Review + mistakes | No open mistakes |"), 38),
    ], 38),
    session("demo-code", "code", text(lang, "修复无参数时的 panic", "Fix the panic with no arguments"), [
      message("demo-code-1", "user", text(lang, "src/main.rs 不带参数运行会直接 panic，帮我看看。", "src/main.rs panics when it runs without arguments. Can you take a look?"), 90),
      message("demo-code-2", "model", text(lang,
        "原因是 `args[1]` 在没有参数时越界。你在下面发一句话，我就把修复演示一遍：读代码、改文件（会先问你批准）、跑测试。",
        "`args[1]` goes out of bounds when there is no argument. Send me a message below and I'll walk through the fix: read the code, change the file (asking for your approval first), and run the tests."), 89),
    ], 89),
  ];
}

const chatTurns = (lang: DemoLang): DemoTurn[] => [
  {
    reasoning: text(lang, "开拓者想聊聊天。先接住情绪，再给一个轻松的话题。", "The Trailblazer wants to talk. Acknowledge the mood first, then offer something light."),
    answer: text(lang,
      "嗯，我听着呢。\n\n这是在线演示，所以我的回答是提前写好的，不会真的读你刚才那句话——桌面版里我会按你说的内容好好回应你。\n\n不过有一件事是真的：累了就歇一会儿，没关系的。",
      "I'm listening.\n\nThis is the online demo, so my replies are written in advance and I don't actually read what you just typed. In the desktop app I answer what you really say.\n\nOne thing is true here too: if you're tired, it's fine to rest for a while."),
    contextTokens: 6_200,
  },
  {
    answer: text(lang,
      "想试试别的模式吗？左上角可以切到 **Work** 或 **Code**，看看我怎么读文件、改代码、等你批准再动手。",
      "Want to try another mode? Switch to **Work** or **Code** at the top left to see me read files, change code, and wait for your approval before acting."),
    contextTokens: 6_900,
  },
];

const workTurns = (lang: DemoLang): DemoTurn[] => [
  {
    reasoning: text(lang, "先读笔记目录，再把计划写成文件。写文件需要开拓者批准。", "Read the notes first, then write the plan to a file. Writing needs approval."),
    tools: [
      { name: "list_dir", displayName: text(lang, "列出目录", "List directory"), args: { path: "notes" }, result: JSON.stringify({ entries: ["linear-algebra.md", "probability.md", "mistakes.md"] }) },
      { name: "read_file", displayName: text(lang, "读取文件", "Read file"), args: { path: "notes/linear-algebra.md" }, result: JSON.stringify({ ok: true, lines: 64 }) },
      { name: "read_file", displayName: text(lang, "读取文件", "Read file"), args: { path: "notes/probability.md" }, result: JSON.stringify({ ok: true, lines: 41 }) },
      {
        name: "write_file", displayName: text(lang, "写入文件", "Write file"), args: { path: "plans/week-44.md" },
        result: JSON.stringify({ ok: true, path: "plans/week-44.md" }),
        changes: [{ file: "plans/week-44.md", kind: "added", insertions: 12, deletions: 0 }],
        approval: { risk: "fs-write", description: text(lang, "在项目里新建 plans/week-44.md", "Create plans/week-44.md in the project") },
      },
    ],
    answer: text(lang,
      "计划已经写进 `plans/week-44.md`，右侧「产出」和「变更」卡片里能看到它。\n\n这是演示，文件不会真的写到你的电脑上。",
      "The plan is in `plans/week-44.md`; you can see it in the Outputs and Changes cards on the right.\n\nThis is a demo, so nothing is written to your computer."),
    contextTokens: 18_400,
  },
  {
    answer: text(lang,
      "桌面版的 Work 模式还能处理 Word、Excel、PDF，联网搜索和定时提醒。每一步写入和命令都会先问你。",
      "In the desktop app, Work mode also handles Word, Excel and PDF files, web search and reminders. Every write and command asks you first."),
    contextTokens: 19_100,
  },
];

const codeTurns = (lang: DemoLang): DemoTurn[] => [
  {
    reasoning: text(lang, "读 main.rs，把 args[1] 换成 args.get(1)，没参数时打印用法并退出 2，然后跑测试。", "Read main.rs, replace args[1] with args.get(1), print usage and exit 2 without an argument, then run the tests."),
    tools: [
      { name: "read_file", displayName: text(lang, "读取文件", "Read file"), args: { path: "src/main.rs" }, result: JSON.stringify({ ok: true, lines: 16 }) },
      {
        name: "apply_patch", displayName: text(lang, "修改文件", "Edit file"), args: { path: "src/main.rs" },
        result: JSON.stringify({ ok: true, files: ["src/main.rs"] }), changes: [mainRsDiff],
        approval: { risk: "fs-write", description: text(lang, "修改 src/main.rs", "Edit src/main.rs") },
      },
      {
        name: "run_command", displayName: text(lang, "执行命令", "Run command"), args: { command: "cargo test" },
        result: JSON.stringify({ exitCode: 0, stdout: "test result: ok. 3 passed; 0 failed" }),
        approval: { risk: "shell", description: "cargo test" },
      },
    ],
    answer: text(lang,
      "改好了，测试 3 个全过。\n\n```rust\nlet text = match args.get(1) {\n    Some(text) => text,\n    None => {\n        eprintln!(\"usage: glowfly <text>\");\n        std::process::exit(2);\n    }\n};\n```\n\n改动在右侧「变更」卡片里，点开能看差异。",
      "Fixed, and all 3 tests pass.\n\n```rust\nlet text = match args.get(1) {\n    Some(text) => text,\n    None => {\n        eprintln!(\"usage: glowfly <text>\");\n        std::process::exit(2);\n    }\n};\n```\n\nThe change is in the Changes card on the right; open it to see the diff."),
    contextTokens: 29_000,
  },
  {
    answer: text(lang,
      "桌面版的 Code 模式在你绑定的项目里工作：Git、语言服务器、结构化搜索，还有可以随时取消的命令。",
      "In the desktop app, Code mode works in the project you bind: Git, language servers, structural search, and commands you can cancel at any time."),
    contextTokens: 29_800,
  },
];

export function demoTurn(mode: ConversationMode, turn: number, lang: DemoLang): DemoTurn {
  const turns = mode === "code" ? codeTurns(lang) : mode === "work" ? workTurns(lang) : chatTurns(lang);
  return turns[Math.min(turn, turns.length - 1)]!;
}
