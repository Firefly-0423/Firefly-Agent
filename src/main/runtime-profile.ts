import fs from "node:fs";
import path from "node:path";

export type RuntimeProfileKind = "production" | "development" | "test" | "smoke";
export interface RuntimeProfile {
  readonly kind: RuntimeProfileKind;
  readonly applicationName: string;
  readonly appData: string;
  readonly userData: string;
  readonly sessionData: string;
  readonly logs: string;
  readonly isolationRoot?: string;
}
export interface RuntimeProfileInput {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
  productionAppData: string;
}

/** Resolve existing ancestors through Windows junctions as well as symlinks. */
export function canonicalPath(value: string): string {
  let current = path.resolve(value);
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("FIREFLY_RUNTIME_ISOLATION_INVALID");
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...suffix);
}
export function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function argument(argv: readonly string[], name: string): string | undefined {
  const values = argv.filter((value) => value === name || value.startsWith(`${name}=`));
  if (values.length > 1 || values.includes(name)) throw new Error("FIREFLY_RUNTIME_ARGUMENT_INVALID");
  return values[0]?.slice(name.length + 1);
}

/** Pure read-only preflight: no mkdir, Electron mutation, settings or logger imports. */
export function resolveRuntimeProfile(input: RuntimeProfileInput): RuntimeProfile {
  const argumentKind = argument(input.argv, "--firefly-profile");
  const argumentRoot = argument(input.argv, "--firefly-isolation-root");
  const legacyRoot = input.env.FIREFLY_ISOLATED_SMOKE_APPDATA;
  const requestedKind = argumentKind ?? input.env.FIREFLY_RUNTIME_PROFILE ?? (legacyRoot === undefined ? undefined : "smoke");
  const isolation = argumentRoot ?? input.env.FIREFLY_ISOLATION_ROOT ?? legacyRoot;
  if (isolation !== undefined && requestedKind === undefined) throw new Error("FIREFLY_RUNTIME_PROFILE_REQUIRED");
  const kind = requestedKind ?? (input.isPackaged ? "production" : "development");
  if (!["production", "development", "test", "smoke"].includes(kind)) throw new Error("FIREFLY_RUNTIME_PROFILE_INVALID");
  if (kind === "production") {
    if (isolation !== undefined) throw new Error("FIREFLY_RUNTIME_PRODUCTION_ISOLATION_INVALID");
    const userData = path.join(input.productionAppData, "Firefly");
    return Object.freeze({ kind, applicationName: "Firefly", appData: input.productionAppData, userData, sessionData: userData, logs: path.join(userData, "logs") });
  }
  if (isolation === undefined || isolation.trim() === "") throw new Error("FIREFLY_RUNTIME_ISOLATION_REQUIRED");
  let isolationRoot: string;
  try {
    if (!path.isAbsolute(isolation)) throw new Error("relative");
    isolationRoot = fs.realpathSync.native(path.resolve(isolation));
    if (!fs.statSync(isolationRoot).isDirectory()) throw new Error("directory");
  } catch {
    throw new Error("FIREFLY_RUNTIME_ISOLATION_INVALID");
  }
  const productionRoot = canonicalPath(input.productionAppData);
  if (within(productionRoot, isolationRoot) || within(isolationRoot, productionRoot)) throw new Error("FIREFLY_RUNTIME_PRODUCTION_OVERLAP");
  const userData = path.join(isolationRoot, `Firefly-${kind}`);
  const profile = { kind: kind as RuntimeProfileKind, applicationName: `Firefly-${kind}`, appData: isolationRoot, userData, sessionData: path.join(userData, "session"), logs: path.join(userData, "logs"), isolationRoot };
  for (const target of [profile.userData, profile.sessionData, profile.logs]) {
    if (!within(isolationRoot, canonicalPath(target))) throw new Error("FIREFLY_RUNTIME_PATH_ESCAPE");
  }
  return Object.freeze(profile);
}

export interface RuntimeProfileApp {
  setName(name: string): void;
  getPath(name: "appData" | "userData" | "sessionData" | "logs"): string;
  setPath(name: "appData" | "userData" | "sessionData", value: string): void;
  setAppLogsPath(value: string): void;
}
/** Electron requires target directories to exist. Call only after read-only preflight. */
export function applyElectronPaths(app: RuntimeProfileApp, profile: RuntimeProfile): void {
  if (profile.isolationRoot !== undefined) {
    for (const target of [profile.appData, profile.userData, profile.sessionData, profile.logs]) {
      if (!within(profile.isolationRoot, canonicalPath(target))) throw new Error("FIREFLY_RUNTIME_PATH_ESCAPE");
    }
  }
  // https://www.electronjs.org/docs/latest/api/app#appsetpathname-path
  for (const root of [profile.appData, profile.userData, profile.sessionData, profile.logs]) fs.mkdirSync(root, { recursive: true });
  app.setName(profile.applicationName);
  if (profile.kind !== "production") app.setPath("appData", profile.appData);
  app.setPath("userData", profile.userData);
  app.setPath("sessionData", profile.sessionData);
  app.setAppLogsPath(profile.logs);
  for (const key of ["appData", "userData", "sessionData", "logs"] as const) {
    if (canonicalPath(app.getPath(key)) !== canonicalPath(profile[key])) throw new Error(`FIREFLY_RUNTIME_${key.toUpperCase()}_FAILED`);
  }
}

export function assertRuntimePathsOwned(profile: RuntimeProfile, targets: readonly string[]): void {
  if (profile.isolationRoot === undefined) return;
  for (const target of targets) {
    if (!within(profile.isolationRoot, canonicalPath(target))) throw new Error("FIREFLY_RUNTIME_PATH_ESCAPE");
  }
}