// 伙伴卡片的英文：昵称、职责、一句话简介。中文直接取 src/shared/specialist-agents.ts，和应用设置页一致。
export const PARTNERS_EN: Readonly<Record<string, readonly [name: string, role: string, intro: string]>> = {
  "strategy-planning": ["Elio", "Strategy and planning", "The one who writes the Stellaron Hunters' script; turns a goal into clear steps you can follow."],
  "architecture": ["Himeko", "Architecture and integration", "The scientist who repaired the Astral Express; warm and well-read, she turns a plan into one consistent technical contract."],
  "implementation": ["Blade", "Implementation", "The Stellaron Hunters' blade. Says little, and gets the code written, refactored and fixed."],
  "research": ["The Herta", "Technical research", "Member #83 of the Genius Society; chases interesting new problems and won't fake enthusiasm for dull ones."],
  "knowledge": ["Dan Heng", "Knowledge", "Guard of the Astral Express; calm and dependable, he sorts out code facts and knowledge."],
  "review": ["Welt", "Quality review", "Once Lord Ravager of Anti-Entropy; steady and careful, he reviews the work independently and holds the bar."],
  "security-governance": ["Sunday", "Security and governance", "Upright and restrained; keeps the line on permissions and risk, and never widens anyone's access."],
  "ui-visual": ["March 7th", "Interface and visuals", "A Trailblazer who loves taking photos; has an eye for the picture and looks after the UI."],
  "documents-data": ["Robin", "Documents and data", "Penacony's singer; makes reports, sheets and documents clear and pleasant to read."],
  "tooling-skills": ["Silver Wolf", "Tools, Skills and troubleshooting", "The Stellaron Hunters' hacker; at home in toolchains, and good at tracing a problem to its root."],
  "ops-release": ["Pom-Pom", "Engineering operations", "Conductor of the Astral Express; keeps builds, releases and day-to-day operations running smoothly."],
  "coordination-debug": ["Kafka", "Coordination", "A Stellaron Hunter who calmly sets out who does what and when; the lead agent makes the final call on delegation."],
};
