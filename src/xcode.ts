import { resolve } from "node:path";
import type { CommandRunner } from "./process";
import type { IOSCoreConfig } from "./types";

export interface XcodeApplicationSettings {
  build: number;
  version: string;
  executableName: string;
  productName: string;
  deploymentTarget: string;
}

interface XcodeSettingsEntry {
  target?: string;
  buildSettings?: Record<string, string>;
}

export function xcodeContainerArguments(config: IOSCoreConfig, root: string): string[] {
  if (config.xcode.project) return ["-project", resolve(root, config.xcode.project)];
  if (config.xcode.workspace) return ["-workspace", resolve(root, config.xcode.workspace)];
  throw new Error("xcode config has no project or workspace.");
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
      `Expected one application target for ${bundleIdentifier}, found ${matches.length}.`,
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
    throw new Error(`Application build settings for ${bundleIdentifier} are incomplete.`);
  }
  return { build, version, executableName, productName, deploymentTarget };
}

export async function readApplicationBuildSettings(
  config: IOSCoreConfig,
  root: string,
  runner: CommandRunner,
): Promise<XcodeApplicationSettings> {
  const output = await runner.capture(
    [
      "xcodebuild",
      "-showBuildSettings",
      "-json",
      ...xcodeContainerArguments(config, root),
      "-scheme",
      config.xcode.scheme,
      "-configuration",
      config.xcode.configuration ?? "Release",
    ],
    { cwd: root },
  );
  return parseApplicationBuildSettings(JSON.parse(output), config.app.bundleIdentifier);
}
