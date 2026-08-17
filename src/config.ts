import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IOSCoreConfig, LoadedConfig, ResolvedDistribution } from "./types";

const CONFIG_NAMES = ["ios-core.config.ts", "ios-core.config.js", "ios-core.config.mjs"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

function assertKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${path} contains unknown fields: ${unexpected.join(", ")}.`);
  }
}

function validateCommand(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty command array.`);
  }
  for (const part of value) assertString(part, path);
}

export function validateConfig(value: unknown): IOSCoreConfig {
  if (!isRecord(value) || value.schemaVersion !== 2) {
    throw new Error("ios-core config must use schemaVersion 2.");
  }
  assertKeys(
    value,
    ["schemaVersion", "app", "expo", "sourceChecks", "signing", "verification", "distribution"],
    "config",
  );
  if (!isRecord(value.app)) throw new Error("app must be an object.");
  assertKeys(value.app, ["id", "displayName", "installerDescription", "bundleIdentifier"], "app");
  assertString(value.app.id, "app.id");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.app.id)) {
    throw new Error("app.id must use lowercase letters, digits, and hyphens.");
  }
  assertString(value.app.displayName, "app.displayName");
  assertString(value.app.bundleIdentifier, "app.bundleIdentifier");
  if (value.app.installerDescription !== undefined) {
    assertString(value.app.installerDescription, "app.installerDescription");
  }

  if (!isRecord(value.expo)) throw new Error("expo must be an object.");
  assertKeys(value.expo, ["projectRoot", "packageManager"], "expo");
  assertString(value.expo.projectRoot, "expo.projectRoot");
  if (isAbsolute(value.expo.projectRoot)) {
    throw new Error("expo.projectRoot must be relative to the ios-core config.");
  }
  if (value.expo.packageManager !== undefined) {
    if (!["bun", "npm", "pnpm", "yarn"].includes(value.expo.packageManager as string)) {
      throw new Error("expo.packageManager must be bun, npm, pnpm, or yarn.");
    }
  }

  if (!Array.isArray(value.sourceChecks)) throw new Error("sourceChecks must be an array.");
  value.sourceChecks.forEach((command, index) => {
    validateCommand(command, `sourceChecks[${index}]`);
  });

  if (!isRecord(value.signing)) throw new Error("signing must be an object.");
  assertKeys(value.signing, ["teamIdentifier", "identity"], "signing");
  assertString(value.signing.teamIdentifier, "signing.teamIdentifier");
  if (value.signing.identity !== undefined)
    assertString(value.signing.identity, "signing.identity");

  if (value.verification !== undefined) {
    if (!isRecord(value.verification)) throw new Error("verification must be an object.");
    assertKeys(
      value.verification,
      ["infoPlist", "forbiddenBundlePatterns", "command"],
      "verification",
    );
    if (value.verification.infoPlist !== undefined) {
      if (!isRecord(value.verification.infoPlist)) {
        throw new Error("verification.infoPlist must be an object.");
      }
      for (const [key, expected] of Object.entries(value.verification.infoPlist)) {
        assertString(key, "verification.infoPlist key");
        if (!["string", "number", "boolean"].includes(typeof expected)) {
          throw new Error(`verification.infoPlist.${key} must be a scalar.`);
        }
      }
    }
    if (value.verification.forbiddenBundlePatterns !== undefined) {
      if (!Array.isArray(value.verification.forbiddenBundlePatterns)) {
        throw new Error("verification.forbiddenBundlePatterns must be an array.");
      }
      value.verification.forbiddenBundlePatterns.forEach((pattern, index) => {
        assertString(pattern, `verification.forbiddenBundlePatterns[${index}]`);
      });
    }
    if (value.verification.command !== undefined) {
      validateCommand(value.verification.command, "verification.command");
    }
  }

  if (!isRecord(value.distribution)) throw new Error("distribution must be an object.");
  assertKeys(value.distribution, ["publicBaseURL", "localPort", "releasesRoot"], "distribution");
  assertString(value.distribution.publicBaseURL, "distribution.publicBaseURL");
  const publicURL = new URL(value.distribution.publicBaseURL);
  if (publicURL.protocol !== "https:") {
    throw new Error("distribution.publicBaseURL must use HTTPS.");
  }
  if (
    !Number.isSafeInteger(value.distribution.localPort) ||
    (value.distribution.localPort as number) < 1 ||
    (value.distribution.localPort as number) > 65_535
  ) {
    throw new Error("distribution.localPort must be a valid TCP port.");
  }
  if (value.distribution.releasesRoot !== undefined) {
    assertString(value.distribution.releasesRoot, "distribution.releasesRoot");
  }

  return value as unknown as IOSCoreConfig;
}

export function resolveExpoProjectRoot(config: IOSCoreConfig, root: string): string {
  const projectRoot = resolve(root, config.expo.projectRoot);
  const relativeProjectRoot = relative(root, projectRoot);
  if (
    relativeProjectRoot === ".." ||
    relativeProjectRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativeProjectRoot)
  ) {
    throw new Error("expo.projectRoot must remain inside the ios-core config directory.");
  }
  return projectRoot;
}

export async function findConfigPath(
  startDirectory: string,
  explicitPath?: string,
): Promise<string> {
  if (explicitPath) return resolve(startDirectory, explicitPath);
  let directory = resolve(startDirectory);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = resolve(directory, name);
      try {
        await access(candidate);
        return candidate;
      } catch {}
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not find ${CONFIG_NAMES.join(", ")} from ${startDirectory}.`);
}

export async function loadConfig(
  startDirectory = process.cwd(),
  explicitPath = process.env.IOS_CORE_CONFIG,
): Promise<LoadedConfig> {
  const configPath = await findConfigPath(startDirectory, explicitPath);
  const module = (await import(`${pathToFileURL(configPath).href}?loaded=${Date.now()}`)) as {
    default?: unknown;
  };
  if (module.default === undefined) throw new Error(`${configPath} must have a default export.`);
  const config = validateConfig(module.default);
  const root = dirname(configPath);
  const hook = config.verification?.command?.[0];
  if (hook?.includes("/")) {
    const hookPath = isAbsolute(hook) ? hook : resolve(root, hook);
    try {
      await access(hookPath);
    } catch {
      throw new Error(`Verification hook does not exist: ${hookPath}.`);
    }
  }
  return { config, configPath, root };
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function resolveDistribution(config: IOSCoreConfig, root: string): ResolvedDistribution {
  const configuredRoot =
    process.env.IOS_CORE_RELEASES_ROOT ??
    config.distribution.releasesRoot ??
    resolve(homedir(), "Builds", config.app.id, "releases");
  const expandedRoot = expandHome(configuredRoot);
  const releasesRoot = isAbsolute(expandedRoot) ? expandedRoot : resolve(root, expandedRoot);
  const publicBaseURL = (
    process.env.IOS_CORE_PUBLIC_BASE_URL ?? config.distribution.publicBaseURL
  ).replace(/\/$/, "");
  const localPort = Number(process.env.IOS_CORE_LOCAL_PORT ?? config.distribution.localPort);
  if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new Error("IOS_CORE_LOCAL_PORT must be a valid TCP port.");
  }
  if (new URL(publicBaseURL).protocol !== "https:") {
    throw new Error("The resolved public base URL must use HTTPS.");
  }
  return { releasesRoot, publicBaseURL, localPort };
}

export async function loadReleaseEnvironment(
  path = process.env.IOS_CORE_ENV ?? resolve(homedir(), ".config/ios-core/release.env"),
): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid release environment line: ${line}`);
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    process.env[key] ??= value;
  }
}
