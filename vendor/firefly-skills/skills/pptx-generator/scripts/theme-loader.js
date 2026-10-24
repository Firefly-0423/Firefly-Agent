"use strict";

// Default palette from the Theme object contract in this Skill's SKILL.md.
function loadTheme(name = "business") {
  if (name !== "business") throw new Error(`Unknown presentation theme: ${name}`);
  return {
    primary: "22223B",
    secondary: "4A4E69",
    accent: "9A8C98",
    light: "C9ADA7",
    bg: "F2E9E4",
  };
}

module.exports = { loadTheme };
