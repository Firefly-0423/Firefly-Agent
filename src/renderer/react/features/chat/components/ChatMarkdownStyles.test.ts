// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));
afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren(); });
function mount(markup: string) {
  const style = document.createElement("style");
  style.textContent = ".text-sm { font-size: 14px; }\n" +
    readFileSync(resolve(directory, "ChatMessageList.css"), "utf8")
      .replace(/var\(--ff-chat-font-size,\s*([^)]+)\)/g, "$1");
  document.head.append(style);
  document.body.innerHTML = markup;
}
const css = (selector: string) => getComputedStyle(document.querySelector(selector)!);

test("Tailwind can discover JavaScript utilities in the installed Streamdown distribution", () => {
  const stylesheet = resolve(directory, "StreamdownMessageContent.css");
  const source = /@source\s+"([^"]+)"/.exec(readFileSync(stylesheet, "utf8"))?.[1];
  expect(source).toBeDefined();
  const distribution = resolve(dirname(stylesheet), source!.replace(/\/\*\.js$/, ""));
  expect(existsSync(distribution)).toBe(true);
  expect(readdirSync(distribution).filter(name => name.endsWith(".js")).length).toBeGreaterThan(0);
});

test("aligns reasoning and sets the heading, table and separator rhythm", () => {
  mount('<section class="ff-message-reasoning"><div class="ant-think-content"></div></section>' +
    '<article class="ff-message ff-message--assistant"><div class="ff-message-markdown">' +
    '<h2>Notes</h2><hr data-streamdown="horizontal-rule"><table data-streamdown="table"><tbody><tr><td class="text-sm">Value</td></tr></tbody></table></div></article>');
  expect(css(".ant-think-content").paddingInlineStart).toBe("46px");
  expect(css("h2").fontSize).toBe("20px");
  expect(css("td").fontSize).toBe("13px");
  expect(css("hr").borderTopWidth).toBe("0px");
  expect(css("hr").backgroundImage).toContain("linear-gradient");
});

test("styles file chips, formula blocks and task lists without disabled-control fading", () => {
  mount('<div class="ff-message-markdown"><button class="ff-file-link">source</button>' +
    '<p><span class="katex">formula</span></p><ul data-streamdown="unordered-list">' +
    '<li id="ordinary" data-streamdown="list-item">item</li><li id="task" data-streamdown="list-item">' +
    '<input type="checkbox" checked disabled></li></ul></div>');
  expect(css(".ff-file-link").borderTopWidth).toBe("0px");
  expect(css(".ff-file-link").backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(css(".ff-file-link").fontWeight).toBe("600");
  expect(css("p").fontSize).toBe("16.24px");
  expect(css("p").marginBottom).toBe("18px");
  expect(css("ul").listStylePosition).toBe("outside");
  expect(css("ul").paddingInlineStart).toBe("22px");
  expect(css("#ordinary").marginTop).toBe("4px");
  expect(css("input").appearance).toBe("none");
  expect(css("input").opacity).toBe("1");
  expect(css("#task").listStyleType).toBe("none");
});
