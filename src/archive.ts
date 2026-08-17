import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prebuildExpoProject, readExpoProjectSettings } from "./expo";
import { renderExportOptions } from "./plist";
import type { CommandRunner } from "./process";
import { systemRunner } from "./process";
import {
  assertSigningIdentity,
  discoverProvisioningProfile,
  parseRequiredDeviceUDIDs,
} from "./profiles";
import type { ExpoProjectSettings, IOSCoreConfig } from "./types";
import { type VerifiedArtifact, verifyExport } from "./verifier";

export interface ArchiveResult extends VerifiedArtifact {
  archivePath: string;
  exportPath: string;
  outputDirectory: string;
  settings: ExpoProjectSettings;
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
  settings?: ExpoProjectSettings;
  runner?: CommandRunner;
}): Promise<ArchiveResult> {
  const runner = options.runner ?? systemRunner;
  const nativeProject = options.settings
    ? {
        projectRoot: options.settings.projectRoot,
        iosDirectory: options.settings.iosDirectory,
        workspacePath: options.settings.workspacePath,
        scheme: options.settings.scheme,
      }
    : await prebuildExpoProject(options.config, options.root, runner);
  const settings =
    options.settings ??
    (await readExpoProjectSettings(options.config, options.root, nativeProject, runner));
  const identity = options.config.signing.identity ?? "Apple Distribution";
  const build = options.build ?? settings.build;
  if (!Number.isSafeInteger(build) || build <= 0) {
    throw new Error("Build must be a positive integer.");
  }
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
      "-workspace",
      nativeProject.workspacePath,
      "-scheme",
      nativeProject.scheme,
      "-configuration",
      "Release",
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      archivePath,
      `CURRENT_PROJECT_VERSION=${build}`,
      `MARKETING_VERSION=${settings.version}`,
      `DEVELOPMENT_TEAM=${options.config.signing.teamIdentifier}`,
      "CODE_SIGN_STYLE=Manual",
      `CODE_SIGN_IDENTITY=${identity}`,
      `PROVISIONING_PROFILE=${profile.uuid}`,
      "SWIFT_TREAT_WARNINGS_AS_ERRORS=YES",
    ],
    { cwd: nativeProject.projectRoot },
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
    { cwd: nativeProject.projectRoot },
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
