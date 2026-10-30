/** Memory categories the graph names, and one hue per category ("r g b" for rgb(var(--node-rgb) / a)): mid tones that
 * read on both themes. Shared by the settings graph and the chat's memory card, so both draw the same colours. */
export const MEMORY_GRAPH_CATEGORIES = ["language", "response-style", "shell", "address", "tool", "preference", "programming-usage", "programming-ability"] as const;
export const MEMORY_GRAPH_CATEGORY_RGB: Record<string, string> = {
  language: "47 153 138", "response-style": "132 102 210", shell: "206 132 38", address: "212 86 118",
  tool: "64 124 206", preference: "70 160 90", "programming-usage": "34 140 190", "programming-ability": "180 120 60", other: "128 134 150",
};
export function memoryGraphCategory(attribute: string | undefined): string {
  return attribute && (MEMORY_GRAPH_CATEGORIES as readonly string[]).includes(attribute) ? attribute : "other";
}
