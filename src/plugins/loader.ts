import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SEMVER_PATTERN } from "../shared/version";
import { CURRENT_PLUGIN_API_VERSION } from "./api";
import { validateManifestData } from "./manifest-validation";
import type { FireflyPlugin, PluginCapability, PluginManifest, PluginRecord, PluginSource } from "./types";
const MANIFEST_FILENAME = "manifest.json";
export const PLUGIN_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCRIPT_SUFFIXES = new Set([".cjs", ".js", ".mjs"]);
const IMAGE_SUFFIXES = new Set(".png .jpg .jpeg .webp .svg".split(" "));
const MEGABYTE = 1024 * 1024;
const IMAGE_SIZE_LIMIT = 2 * MEGABYTE;
const PANEL_SIZE_LIMIT = MEGABYTE;
type EsmImporter = (specifier: string) => Promise<Record<string, unknown>>;
const importNativeModule = require("./native-import.cjs") as EsmImporter;
let importSequence = 0;
export type PluginScanIssue = {
    message: string;
    source: PluginSource;
    path?: string;
    root: string;
};
export type ManifestInspection = {
    fingerprint?: string;
    error?: string;
    manifest: PluginManifest | null;
};
const describeFailure = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));
const outsideDirectory = (directory: string, filename: string): boolean => {
    const relativeName = path.relative(directory, filename);
    return relativeName.startsWith("..") || path.isAbsolute(relativeName);
};
function optionalAsset(pluginDirectory: string, declaredAsset: unknown, acceptsExtension: (extension: string) => boolean, sizeLimit: number): string | undefined {
    if (declaredAsset === undefined || declaredAsset === null || declaredAsset === "")
        return undefined;
    if (typeof declaredAsset !== "string")
        return undefined;
    if (path.basename(declaredAsset) !== declaredAsset)
        return undefined;
    if (!acceptsExtension(path.extname(declaredAsset).toLowerCase()))
        return undefined;
    const assetPath = path.join(pluginDirectory, declaredAsset);
    let metadata: ReturnType<typeof statSync>;
    try {
        metadata = statSync(assetPath);
    }
    catch {
        return undefined;
    }
    if (!metadata.isFile() || metadata.size > sizeLimit)
        return undefined;
    try {
        if (outsideDirectory(realpathSync(pluginDirectory), realpathSync(assetPath)))
            return undefined;
    }
    catch {
        return undefined;
    }
    return declaredAsset;
}
const validatedIcon = (pluginDirectory: string, iconName: unknown): string | undefined => optionalAsset(pluginDirectory, iconName, (extension) => IMAGE_SUFFIXES.has(extension), IMAGE_SIZE_LIMIT);
const validatedHtmlPanel = (pluginDirectory: string, panelName: unknown): string | undefined => optionalAsset(pluginDirectory, panelName, (extension) => extension === ".html", PANEL_SIZE_LIMIT);
const invalidManifest = (failure: string): ManifestInspection => ({ manifest: null, error: failure });
export function inspectPluginDir(pluginDirectory: string): ManifestInspection {
    const manifestFilename = path.join(pluginDirectory, MANIFEST_FILENAME);
    if (!existsSync(manifestFilename))
        return invalidManifest("缺少 manifest.json");
    try {
        const manifestContents = readFileSync(manifestFilename, "utf8");
        const validation = validateManifestData(JSON.parse(manifestContents) as unknown);
        if (!validation.ok || !validation.value)
            return invalidManifest(validation.error ?? "manifest 结构不合法");
        const fields = validation.value;
        if (fields.apiVersion !== CURRENT_PLUGIN_API_VERSION) {
            return invalidManifest(`不兼容的 apiVersion: ${String(fields.apiVersion)}（当前支持 ${CURRENT_PLUGIN_API_VERSION}）`);
        }
        if (typeof fields.id !== "string" || !PLUGIN_ID_RE.test(fields.id))
            return invalidManifest("id 不符合小写连字符格式");
        if (typeof fields.name !== "string" || !fields.name.trim())
            return invalidManifest("name 不能为空");
        if (typeof fields.version !== "string" || !SEMVER_PATTERN.test(fields.version)) {
            return invalidManifest("version 必须是合法 SemVer");
        }
        if (typeof fields.entry !== "string" || !fields.entry)
            return invalidManifest("entry 不能为空");
        if (path.basename(fields.entry) !== fields.entry)
            return invalidManifest("entry 必须是插件目录内的裸文件名");
        if (!SCRIPT_SUFFIXES.has(path.extname(fields.entry).toLowerCase())) {
            return invalidManifest("entry 扩展名仅支持 .cjs/.js/.mjs");
        }
        const requirements = fields.deps ? ([...new Set(fields.deps)] as PluginCapability[]) : undefined;
        const entryFilename = path.join(pluginDirectory, fields.entry);
        if (!existsSync(entryFilename) || !statSync(entryFilename).isFile()) {
            return invalidManifest(`入口文件不存在: ${fields.entry}`);
        }
        const resolvedDirectory = realpathSync(pluginDirectory);
        const resolvedEntry = realpathSync(entryFilename);
        if (outsideDirectory(resolvedDirectory, resolvedEntry))
            return invalidManifest("entry 不能通过链接指向插件目录外");
        const validatedPanel = validatedHtmlPanel(pluginDirectory, fields.settingsPanel);
        const displayFields = { name: fields.name.trim(), description: fields.description.trim(), author: fields.author.trim() };
        const description: PluginManifest = {
            apiVersion: CURRENT_PLUGIN_API_VERSION,
            id: fields.id,
            name: displayFields.name,
            version: fields.version,
            description: displayFields.description,
            author: displayFields.author,
            entry: fields.entry,
            icon: validatedIcon(pluginDirectory, fields.icon),
            settingsPanel: validatedPanel,
            settingsSection: validatedPanel ? fields.settingsSection : undefined,
            defaultEnabled: fields.defaultEnabled !== false,
            deps: requirements,
        };
        const digest = createHash("sha256");
        digest.update(manifestContents);
        digest.update("\0");
        digest.update(readFileSync(resolvedEntry));
        return { manifest: description, fingerprint: digest.digest("hex") };
    }
    catch (failure) {
        return invalidManifest(describeFailure(failure));
    }
}
export function readManifest(pluginDirectory: string): PluginManifest | null {
    return inspectPluginDir(pluginDirectory).manifest;
}
export function scanPluginDir(scanDirectory: string, origin: PluginSource = "user", reportIssue?: (problem: PluginScanIssue) => void): PluginRecord[] {
    if (!existsSync(scanDirectory))
        return [];
    let directoryEntries: Dirent<string>[];
    try {
        directoryEntries = readdirSync(scanDirectory, { withFileTypes: true });
    }
    catch (failure) {
        const problem = { root: scanDirectory, source: origin, message: `无法扫描插件目录: ${describeFailure(failure)}` } satisfies PluginScanIssue;
        reportIssue?.(problem);
        console.warn(`[plugins] ${problem.message}: ${scanDirectory}`);
        return [];
    }
    const discovered: PluginRecord[] = [];
    for (const directoryEntry of directoryEntries) {
        if (!directoryEntry.isDirectory())
            continue;
        const pluginDirectory = path.join(scanDirectory, directoryEntry.name);
        const inspection = inspectPluginDir(pluginDirectory);
        if (!inspection.manifest || !inspection.fingerprint) {
            const problem = {
                root: scanDirectory,
                path: pluginDirectory,
                source: origin,
                message: inspection.error ?? "无效 manifest",
            } satisfies PluginScanIssue;
            reportIssue?.(problem);
            console.warn(`[plugins] 忽略无效插件目录: ${pluginDirectory} (${problem.message})`);
            continue;
        }
        discovered.push({ manifest: inspection.manifest, dir: pluginDirectory, source: origin, fingerprint: inspection.fingerprint });
    }
    return discovered;
}
export function clearPluginModuleCache(pluginDirectory: string): void {
    const scanDirectory = path.resolve(pluginDirectory);
    for (const cachedFilename of Object.keys(require.cache)) {
        if (!outsideDirectory(scanDirectory, cachedFilename))
            delete require.cache[cachedFilename];
    }
}
export async function loadPlugin(packageRecord: PluginRecord): Promise<FireflyPlugin> {
    const entryFilename = path.join(packageRecord.dir, packageRecord.manifest.entry);
    clearPluginModuleCache(packageRecord.dir);
    let exportsObject: Record<string, unknown>;
    if (path.extname(entryFilename).toLowerCase() === ".mjs") {
        const moduleUrl = new URL(pathToFileURL(entryFilename).href);
        importSequence += 1;
        moduleUrl.searchParams.set("fireflyReload", `${packageRecord.fingerprint}-${Date.now()}-${importSequence}`);
        exportsObject = await importNativeModule(moduleUrl.href);
    }
    else {
        exportsObject = require(entryFilename) as Record<string, unknown>;
    }
    const implementation = (exportsObject.default ?? exportsObject) as Partial<FireflyPlugin>;
    if (typeof implementation.register !== "function") {
        throw new Error(`插件 ${packageRecord.manifest.id} 入口未导出 register()`);
    }
    return implementation as FireflyPlugin;
}
