import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { createFingerprintAsync } from "@expo/fingerprint";
import { resolveExpoProjectRoot } from "./config";
import type { CommandRunner } from "./process";
import { systemRunner } from "./process";
import type { ExpoProjectSettings, IOSCoreConfig, PackageManager } from "./types";

export interface ExpoAppConfig {
  name?: unknown;
  slug?: unknown;
  version?: unknown;
  ios?: {
    bundleIdentifier?: unknown;
    buildNumber?: unknown;
    deploymentTarget?: unknown;
  };
}

export interface ExpoNativeProject {
  projectRoot: string;
  iosDirectory: string;
  workspacePath: string;
  scheme: string;
}

interface NativeFingerprintState {
  schemaVersion: 1;
  appId: string;
  projectRoot: string;
  hash: string;
}

function packageManagerCommand(packageManager: PackageManager): string[] {
  switch (packageManager) {
    case "bun":
      return ["bunx", "--no-install", "expo"];
    case "npm":
      return ["npx", "--no-install", "expo"];
    case "pnpm":
      return ["pnpm", "exec", "expo"];
    case "yarn":
      return ["yarn", "expo"];
  }
}

async function inferPackageManager(projectRoot: string): Promise<PackageManager> {
  let directory = projectRoot;
  while (true) {
    try {
      const packageJSON = JSON.parse(
        await readFile(resolve(directory, "package.json"), "utf8"),
      ) as {
        packageManager?: unknown;
      };
      if (typeof packageJSON.packageManager === "string") {
        const [manager] = packageJSON.packageManager.split("@", 1);
        if (manager === "bun" || manager === "npm" || manager === "pnpm" || manager === "yarn") {
          return manager;
        }
      }
    } catch {}
    for (const [manager, lockfile] of [
      ["bun", "bun.lock"],
      ["bun", "bun.lockb"],
      ["pnpm", "pnpm-lock.yaml"],
      ["yarn", "yarn.lock"],
      ["npm", "package-lock.json"],
    ] as const) {
      try {
        await access(resolve(directory, lockfile));
        return manager;
      } catch {}
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return "bun";
}

export async function expoCommand(
  config: IOSCoreConfig,
  root: string,
  projectRoot = resolveExpoProjectRoot(config, root),
): Promise<readonly [string, ...string[]]> {
  const packageManager = config.expo.packageManager ?? (await inferPackageManager(projectRoot));
  return packageManagerCommand(packageManager) as [string, ...string[]];
}

export async function readExpoAppConfig(
  config: IOSCoreConfig,
  root: string,
  runner: CommandRunner = systemRunner,
): Promise<ExpoAppConfig> {
  const projectRoot = resolveExpoProjectRoot(config, root);
  const command = await expoCommand(config, root, projectRoot);
  const output = await runner.capture([...command, "config", "--json"], { cwd: projectRoot });
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("Expo config did not return JSON.", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expo config returned an invalid object.");
  }
  return parsed as ExpoAppConfig;
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expo config ${label} must be a non-empty string.`);
  }
  return value;
}

export async function prebuildExpoProject(
  config: IOSCoreConfig,
  root: string,
  runner: CommandRunner = systemRunner,
): Promise<ExpoNativeProject> {
  const projectRoot = resolveExpoProjectRoot(config, root);
  const command = await expoCommand(config, root, projectRoot);
  const packageJSONPath = resolve(projectRoot, "package.json");
  const packageJSON = await readFile(packageJSONPath);
  try {
    await runner.run([...command, "prebuild", "--platform", "ios", "--clean", "--no-install"], {
      cwd: projectRoot,
      environment: { EXPO_NO_GIT_STATUS: "1" },
    });
  } finally {
    await writeFile(packageJSONPath, packageJSON);
  }
  await runner.run(["pod", "install", "--project-directory", resolve(projectRoot, "ios")], {
    cwd: projectRoot,
  });
  return readExpoNativeProject(config, root);
}

export async function readExpoNativeProject(
  config: IOSCoreConfig,
  root: string,
): Promise<ExpoNativeProject> {
  const projectRoot = resolveExpoProjectRoot(config, root);
  const iosDirectory = resolve(projectRoot, "ios");
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(iosDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Expo iOS project is missing. Run ios-core prebuild first.`, { cause: error });
  }
  const workspaces = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcworkspace"))
    .map((entry) => resolve(iosDirectory, entry.name));
  if (workspaces.length !== 1) {
    throw new Error(
      `Expo prebuild must produce exactly one iOS workspace, found ${workspaces.length}.`,
    );
  }
  const workspacePath = workspaces[0];
  if (!workspacePath) throw new Error("Expo iOS workspace disappeared while resolving it.");
  return {
    projectRoot,
    iosDirectory,
    workspacePath,
    scheme: basename(workspacePath, ".xcworkspace"),
  };
}

interface XcodeSettingsEntry {
  buildSettings?: Record<string, string>;
}

interface XcodeApplicationSettings {
  build: number;
  version: string;
  executableName: string;
  productName: string;
  deploymentTarget: string;
}

export function parseApplicationBuildSettings(
  value: unknown,
  bundleIdentifier: string,
): XcodeApplicationSettings {
  if (!Array.isArray(value)) throw new Error("xcodebuild returned invalid build settings.");
  const matches = (value as XcodeSettingsEntry[]).filter((entry) => {
    const settings = entry.buildSettings;
    return (
      settings?.PRODUCT_BUNDLE_IDENTIFIER === bundleIdentifier &&
      settings.WRAPPER_EXTENSION === "app"
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected one Expo application target for ${bundleIdentifier}, found ${matches.length}.`,
    );
  }
  const settings = matches[0]?.buildSettings;
  const build = Number(settings?.CURRENT_PROJECT_VERSION);
  const version = settings?.MARKETING_VERSION;
  const executableName = settings?.EXECUTABLE_NAME;
  const productName = settings?.PRODUCT_NAME;
  const deploymentTarget = settings?.IPHONEOS_DEPLOYMENT_TARGET;
  if (
    !Number.isSafeInteger(build) ||
    build <= 0 ||
    !version ||
    !executableName ||
    !productName ||
    !deploymentTarget
  ) {
    throw new Error(`Expo application build settings for ${bundleIdentifier} are incomplete.`);
  }
  return { build, version, executableName, productName, deploymentTarget };
}

export async function readApplicationBuildSettings(
  config: IOSCoreConfig,
  _root: string,
  nativeProject: ExpoNativeProject,
  runner: CommandRunner = systemRunner,
): Promise<XcodeApplicationSettings> {
  const output = await runner.capture(
    [
      "xcodebuild",
      "-showBuildSettings",
      "-json",
      "-workspace",
      nativeProject.workspacePath,
      "-scheme",
      nativeProject.scheme,
      "-configuration",
      "Release",
    ],
    { cwd: nativeProject.projectRoot },
  );
  return parseApplicationBuildSettings(JSON.parse(output), config.app.bundleIdentifier);
}

function fingerprintStatePath(appId: string): string {
  const cacheRoot =
    process.env.IOS_CORE_CACHE_ROOT ?? resolve(homedir(), "Library/Caches/ios-core");
  return resolve(cacheRoot, "fingerprints", `${appId}.ios.json`);
}

export async function createNativeFingerprint(
  config: IOSCoreConfig,
  root: string,
): Promise<string> {
  const projectRoot = resolveExpoProjectRoot(config, root);
  const fingerprint = await createFingerprintAsync(projectRoot, {
    platforms: ["ios"],
    silent: true,
  });
  return fingerprint.hash;
}

export async function readStoredNativeFingerprint(
  appId: string,
  projectRoot?: string,
): Promise<string | undefined> {
  try {
    const value = JSON.parse(
      await readFile(fingerprintStatePath(appId), "utf8"),
    ) as Partial<NativeFingerprintState>;
    if (
      value.schemaVersion !== 1 ||
      value.appId !== appId ||
      (projectRoot !== undefined && value.projectRoot !== projectRoot) ||
      typeof value.hash !== "string"
    ) {
      throw new Error(`Invalid stored native fingerprint for ${appId}.`);
    }
    return value.hash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function storeNativeFingerprint(
  config: IOSCoreConfig,
  root: string,
  hash: string,
): Promise<void> {
  const path = fingerprintStatePath(config.app.id);
  await mkdir(dirname(path), { recursive: true });
  const state: NativeFingerprintState = {
    schemaVersion: 1,
    appId: config.app.id,
    projectRoot: resolveExpoProjectRoot(config, root),
    hash,
  };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function nativeBuildRequired(
  config: IOSCoreConfig,
  root: string,
): Promise<{ required: boolean; fingerprint: string; storedFingerprint?: string }> {
  const fingerprint = await createNativeFingerprint(config, root);
  const storedFingerprint = await readStoredNativeFingerprint(
    config.app.id,
    resolveExpoProjectRoot(config, root),
  );
  return {
    required: storedFingerprint !== fingerprint,
    fingerprint,
    ...(storedFingerprint ? { storedFingerprint } : {}),
  };
}

export async function readExpoProjectSettings(
  config: IOSCoreConfig,
  root: string,
  nativeProject: ExpoNativeProject,
  runner: CommandRunner = systemRunner,
): Promise<ExpoProjectSettings> {
  const [appConfig, nativeSettings, nativeFingerprint] = await Promise.all([
    readExpoAppConfig(config, root, runner),
    readApplicationBuildSettings(config, root, nativeProject, runner),
    createNativeFingerprint(config, root),
  ]);
  const bundleIdentifier = assertNonEmptyString(
    appConfig.ios?.bundleIdentifier,
    "ios.bundleIdentifier",
  );
  if (bundleIdentifier !== config.app.bundleIdentifier) {
    throw new Error(
      `Expo bundle identifier ${bundleIdentifier} does not match ios-core ${config.app.bundleIdentifier}.`,
    );
  }
  const version = assertNonEmptyString(appConfig.version ?? nativeSettings.version, "version");
  if (version !== nativeSettings.version) {
    throw new Error(
      `Expo version ${version} does not match generated iOS settings ${nativeSettings.version}.`,
    );
  }
  return {
    ...nativeProject,
    ...nativeSettings,
    bundleIdentifier,
    version,
    nativeFingerprint,
  };
}

export function expoRunIOSCommand(
  command: readonly [string, ...string[]],
  options: { device?: string; noBundler?: boolean } = {},
): readonly [string, ...string[]] {
  return [
    ...command,
    "run:ios",
    ...(options.device ? ["--device", options.device] : []),
    ...(options.noBundler ? ["--no-bundler"] : []),
  ];
}

export function resolveDevelopmentDevice(
  explicitDevice: string | undefined,
  configuredDevice = process.env.IOS_CORE_DEV_DEVICE,
): string | undefined {
  const device = explicitDevice?.trim() || configuredDevice?.trim();
  return device || undefined;
}

export function expoStartCommand(
  command: readonly [string, ...string[]],
  options: { port?: number; host?: "lan" | "localhost" | "tunnel" } = {},
): readonly [string, ...string[]] {
  return [
    ...command,
    "start",
    "--dev-client",
    ...(options.port ? ["--port", String(options.port)] : []),
    ...(options.host ? [`--host`, options.host] : []),
  ];
}
