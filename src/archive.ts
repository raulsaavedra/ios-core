import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderExportOptions } from "./plist";
import type { CommandRunner } from "./process";
import { systemRunner } from "./process";
import {
  assertSigningIdentity,
  discoverProvisioningProfile,
  parseRequiredDeviceUDIDs,
} from "./profiles";
import type { IOSCoreConfig } from "./types";
import { type VerifiedArtifact, verifyExport } from "./verifier";
import {
  readApplicationBuildSettings,
  type XcodeApplicationSettings,
  xcodeContainerArguments,
} from "./xcode";

export interface ArchiveResult extends VerifiedArtifact {
  archivePath: string;
  exportPath: string;
  outputDirectory: string;
  settings: XcodeApplicationSettings;
}

async function assertOutputDoesNotExist(outputDirectory: string): Promise<void> {
  try {
    await stat(outputDirectory);
    throw new Error(`Archive output already exists: ${outputDirectory}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function createArchive(options: {
  config: IOSCoreConfig;
  root: string;
  outputDirectory: string;
  build?: number;
  settings?: XcodeApplicationSettings;
  runner?: CommandRunner;
}): Promise<ArchiveResult> {
  const runner = options.runner ?? systemRunner;
  const identity = options.config.signing.identity ?? "Apple Distribution";
  const settings =
    options.settings ?? (await readApplicationBuildSettings(options.config, options.root, runner));
  const build = options.build ?? settings.build;
  if (!Number.isSafeInteger(build) || build <= 0)
    throw new Error("Build must be a positive integer.");
  const requiredDevices = parseRequiredDeviceUDIDs();
  await assertSigningIdentity(identity, runner);
  const profile = await discoverProvisioningProfile(
    {
      bundleIdentifier: options.config.app.bundleIdentifier,
      teamIdentifier: options.config.signing.teamIdentifier,
      requiredDevices,
    },
    runner,
  );
  await assertOutputDoesNotExist(options.outputDirectory);
  await mkdir(options.outputDirectory, { recursive: true });
  const archivePath = resolve(options.outputDirectory, `${settings.productName}.xcarchive`);
  const exportPath = resolve(options.outputDirectory, "export");
  const exportOptionsPath = resolve(options.outputDirectory, "ExportOptions.plist");
  await writeFile(
    exportOptionsPath,
    renderExportOptions({
      bundleIdentifier: options.config.app.bundleIdentifier,
      profileName: profile.uuid,
      signingIdentity: identity,
      teamIdentifier: options.config.signing.teamIdentifier,
    }),
  );

  await runner.run(
    [
      "xcodebuild",
      "archive",
      ...xcodeContainerArguments(options.config, options.root),
      "-scheme",
      options.config.xcode.scheme,
      "-configuration",
      options.config.xcode.configuration ?? "Release",
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      archivePath,
      `CURRENT_PROJECT_VERSION=${build}`,
      `DEVELOPMENT_TEAM=${options.config.signing.teamIdentifier}`,
      "CODE_SIGN_STYLE=Manual",
      `CODE_SIGN_IDENTITY=${identity}`,
      `PROVISIONING_PROFILE=${profile.uuid}`,
      "SWIFT_TREAT_WARNINGS_AS_ERRORS=YES",
    ],
    { cwd: options.root },
  );
  await runner.run(
    [
      "xcodebuild",
      "-exportArchive",
      "-archivePath",
      archivePath,
      "-exportPath",
      exportPath,
      "-exportOptionsPlist",
      exportOptionsPath,
    ],
    { cwd: options.root },
  );
  const verified = await verifyExport({
    config: options.config,
    root: options.root,
    outputDirectory: options.outputDirectory,
    archivePath,
    exportPath,
    build,
    settings,
    profile,
    requiredDevices,
    runner,
  });
  return {
    ...verified,
    archivePath,
    exportPath,
    outputDirectory: options.outputDirectory,
    settings,
  };
}
