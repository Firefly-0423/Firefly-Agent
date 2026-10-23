// 图标资源来自 vscode-icons/vscode-icons（MIT），保留对应来源与许可。
import typescriptIcon from "../../../../../../assets/icons/vscode/file_type_typescript.svg";
import reacttsIcon from "../../../../../../assets/icons/vscode/file_type_reactts.svg";
import lightJsIcon from "../../../../../../assets/icons/vscode/file_type_light_js.svg";
import reactjsIcon from "../../../../../../assets/icons/vscode/file_type_reactjs.svg";
import lightJsonIcon from "../../../../../../assets/icons/vscode/file_type_light_json.svg";
import cssIcon from "../../../../../../assets/icons/vscode/file_type_css.svg";
import scssIcon from "../../../../../../assets/icons/vscode/file_type_scss.svg";
import lessIcon from "../../../../../../assets/icons/vscode/file_type_less.svg";
import htmlIcon from "../../../../../../assets/icons/vscode/file_type_html.svg";
import markdownIcon from "../../../../../../assets/icons/vscode/file_type_markdown.svg";
import textIcon from "../../../../../../assets/icons/vscode/file_type_text.svg";
import pythonIcon from "../../../../../../assets/icons/vscode/file_type_python.svg";
import lightRustIcon from "../../../../../../assets/icons/vscode/file_type_light_rust.svg";
import goIcon from "../../../../../../assets/icons/vscode/file_type_go.svg";
import javaIcon from "../../../../../../assets/icons/vscode/file_type_java.svg";
import cIcon from "../../../../../../assets/icons/vscode/file_type_c.svg";
import cppIcon from "../../../../../../assets/icons/vscode/file_type_cpp.svg";
import cheaderIcon from "../../../../../../assets/icons/vscode/file_type_cheader.svg";
import csharpIcon from "../../../../../../assets/icons/vscode/file_type_csharp.svg";
import phpIcon from "../../../../../../assets/icons/vscode/file_type_php.svg";
import rubyIcon from "../../../../../../assets/icons/vscode/file_type_ruby.svg";
import shellIcon from "../../../../../../assets/icons/vscode/file_type_shell.svg";
import lightYamlIcon from "../../../../../../assets/icons/vscode/file_type_light_yaml.svg";
import xmlIcon from "../../../../../../assets/icons/vscode/file_type_xml.svg";
import sqlIcon from "../../../../../../assets/icons/vscode/file_type_sql.svg";
import vueIcon from "../../../../../../assets/icons/vscode/file_type_vue.svg";
import svelteIcon from "../../../../../../assets/icons/vscode/file_type_svelte.svg";
import lightTomlIcon from "../../../../../../assets/icons/vscode/file_type_light_toml.svg";
import luaIcon from "../../../../../../assets/icons/vscode/file_type_lua.svg";
import dartlangIcon from "../../../../../../assets/icons/vscode/file_type_dartlang.svg";
import kotlinIcon from "../../../../../../assets/icons/vscode/file_type_kotlin.svg";
import swiftIcon from "../../../../../../assets/icons/vscode/file_type_swift.svg";
import batIcon from "../../../../../../assets/icons/vscode/file_type_bat.svg";
import powershellIcon from "../../../../../../assets/icons/vscode/file_type_powershell.svg";
import svgIcon from "../../../../../../assets/icons/vscode/file_type_svg.svg";
import imageIcon from "../../../../../../assets/icons/vscode/file_type_image.svg";
import pdfIcon from "../../../../../../assets/icons/vscode/file_type_pdf.svg";
import zipIcon from "../../../../../../assets/icons/vscode/file_type_zip.svg";
import npmIcon from "../../../../../../assets/icons/vscode/file_type_npm.svg";
import gitIcon from "../../../../../../assets/icons/vscode/file_type_git.svg";
import dockerIcon from "../../../../../../assets/icons/vscode/file_type_docker.svg";
import nodeIcon from "../../../../../../assets/icons/vscode/file_type_node.svg";

const extensions: Record<string, string> = Object.fromEntries([
  [typescriptIcon, "ts"],
  [reacttsIcon, "tsx"],
  [lightJsIcon, "js mjs cjs"],
  [reactjsIcon, "jsx"],
  [lightJsonIcon, "json jsonc"],
  [cssIcon, "css"],
  [scssIcon, "scss sass"],
  [lessIcon, "less"],
  [htmlIcon, "html htm"],
  [markdownIcon, "md markdown mdx"],
  [textIcon, "txt"],
  [pythonIcon, "py pyw"],
  [lightRustIcon, "rs"],
  [goIcon, "go"],
  [javaIcon, "java"],
  [cIcon, "c"],
  [cppIcon, "cpp cc cxx"],
  [cheaderIcon, "h hpp"],
  [csharpIcon, "cs"],
  [phpIcon, "php"],
  [rubyIcon, "rb"],
  [shellIcon, "sh bash zsh"],
  [lightYamlIcon, "yaml yml"],
  [xmlIcon, "xml"],
  [sqlIcon, "sql"],
  [vueIcon, "vue"],
  [svelteIcon, "svelte"],
  [lightTomlIcon, "toml"],
  [luaIcon, "lua"],
  [dartlangIcon, "dart"],
  [kotlinIcon, "kt kts"],
  [swiftIcon, "swift"],
  [batIcon, "bat cmd"],
  [powershellIcon, "ps1"],
  [svgIcon, "svg"],
  [imageIcon, "png jpg jpeg gif webp ico bmp"],
  [pdfIcon, "pdf"],
  [zipIcon, "zip gz rar 7z"],
].flatMap(([icon, suffixes]) => suffixes.split(" ").map((suffix) => [suffix, icon])));

const specialNames: Record<string, string> = Object.fromEntries([
  [npmIcon, "package.json package-lock.json pnpm-lock.yaml yarn.lock"],
  [gitIcon, ".gitignore .gitattributes .gitmodules"],
  [dockerIcon, "dockerfile .dockerignore docker-compose.yml docker-compose.yaml"],
  [nodeIcon, ".nvmrc .node-version"],
].flatMap(([icon, names]) => names.split(" ").map((filename) => [filename, icon])));

export function vscodeIconForFile(name: string): string | null {
  const filename = name.toLowerCase();
  const exact = specialNames[filename];
  if (exact) return exact;
  const separator = filename.lastIndexOf(".");
  return separator > 0 ? extensions[filename.slice(separator + 1)] ?? null : null;
}
