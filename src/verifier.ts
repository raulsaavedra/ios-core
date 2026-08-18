import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, relative, resolve } from "node:path";
import { parsePlist, readPlist } from "./plist";
import type { CommandRunner } from "./process";
import { decodeProvisioningProfile, type ProvisioningProfile } from "./profiles";
import type { Command, IOSCoreConfig } from "./types";
import type { XcodeApplicationSettings } from "./xcode";

export interface ArchiveProperties {
  ApplicationPath?: string;
  Architectures?: string[];
  CFBundleIdentifier?: string;
  CFBundleShortVersionString?: string;
  CFBundleVersion?: string;
  SigningIdentity?: string;
  Team?: string;
}

export async function readArchiveProperties(
  archiveInfoPath: string,
  runner: CommandRunner,
): Promise<ArchiveProperties> {
  return JSON.parse(
    await runner.capture([
      "plutil",
      "-extract",
      "ApplicationProperties",
      "json",
      "-o",
      "-",
      archiveInfoPath,
    ]),
  ) as ArchiveProperties;
}

interface DistributionEntry {
  buildNumber?: string;
  versionNumber?: string;
  architectures?: string[];
  profile?: { UUID?: string };
}

export interface VerifiedArtifact {
  ipaPath: string;
  ipaName: string;
  sha256: string;
  size: number;
  profileUUID: string;
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}

function globExpression(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*")
    .replaceAll("?", "[^/]");
  return new RegExp(`^${escaped}$`, "i");
}

export function findForbiddenPaths(paths: string[], patterns: string[]): string[] {
  const expressions = patterns.map(globExpression);
  return paths.filter((path) => {
    const normalized = path.replaceAll("\\", "/");
    return expressions.some(
      (expression) => expression.test(normalized) || expression.test(basename(normalized)),
    );
  });
}

function substituteHookCommand(
  command: Command,
  values: { appPath: string; outputDir: string; ipaPath: string; archivePath: string },
): Command {
  const substituted = command.map((part) =>
    part
      .replaceAll("{appPath}", values.appPath)
      .replaceAll("{outputDir}", values.outputDir)
      .replaceAll("{ipaPath}", values.ipaPath)
      .replaceAll("{archivePath}", values.archivePath),
  );
  if (!substituted[0]) throw new Error("Verification hook command cannot be empty.");
  return substituted as unknown as Command;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}.`,
    );
  }
}

async function findSingleIPA(exportPath: string): Promise<string> {
  const entries = await readdir(exportPath, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ipa"));
  if (names.length !== 1) throw new Error(`Expected one exported IPA, found ${names.length}.`);
  const ipa = names[0];
  if (!ipa) throw new Error("Exported IPA disappeared while verifying it.");
  return resolve(exportPath, ipa.name);
}

async function digestFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

export async function verifyExport(options: {
  config: IOSCoreConfig;
  root: string;
  outputDirectory: string;
  archivePath: string;
  exportPath: string;
  build: number;
  settings: XcodeApplicationSettings;
  profile: ProvisioningProfile;
  requiredDevices: string[];
  runner: CommandRunner;
}): Promise<VerifiedArtifact> {
  const { config, runner } = options;
  const ipaPath = await findSingleIPA(options.exportPath);
  const ipaName = basename(ipaPath);
  const archiveInfoPath = resolve(options.archivePath, "Info.plist");
  await runner.run(["unzip", "-tq", ipaPath]);
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), `${config.app.id}-export-`));
  try {
    await runner.run(["ditto", "-x", "-k", ipaPath, temporaryDirectory]);
    const payloadPath = resolve(temporaryDirectory, "Payload");
    const apps = (await readdir(payloadPath, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
    );
    if (apps.length !== 1)
      throw new Error(`Expected one application bundle, found ${apps.length}.`);
    const app = apps[0];
    if (!app) throw new Error("Application bundle disappeared while verifying it.");
    const appPath = resolve(payloadPath, app.name);
    const infoPath = resolve(appPath, "Info.plist");
    const appInfo = await readPlist<Record<string, unknown>>(infoPath, runner);
    const archive = await readArchiveProperties(archiveInfoPath, runner);

    assertEqual(
      archive.CFBundleIdentifier,
      config.app.bundleIdentifier,
      "Archive bundle identifier",
    );
    assertEqual(appInfo.CFBundleIdentifier, config.app.bundleIdentifier, "IPA bundle identifier");
    assertEqual(archive.CFBundleShortVersionString, options.settings.version, "Archive version");
    assertEqual(appInfo.CFBundleShortVersionString, options.settings.version, "IPA version");
    assertEqual(archive.CFBundleVersion, String(options.build), "Archive build");
    assertEqual(appInfo.CFBundleVersion, String(options.build), "IPA build");
    assertEqual(appInfo.MinimumOSVersion, options.settings.deploymentTarget, "Minimum OS version");
    if (archive.Architectures?.join(" ") !== "arm64") {
      throw new Error(`Archive architectures must be exactly arm64.`);
    }
    const executablePath = resolve(appPath, options.settings.executableName);
    assertEqual(
      await runner.capture(["lipo", "-archs", executablePath]),
      "arm64",
      "IPA architecture",
    );

    for (const [key, expected] of Object.entries(config.verification?.infoPlist ?? {})) {
      assertEqual(appInfo[key], expected, `Info.plist ${key}`);
    }
    const forbidden = findForbiddenPaths(
      await walkFiles(appPath),
      config.verification?.forbiddenBundlePatterns ?? [],
    );
    if (forbidden.length > 0) {
      throw new Error(`Forbidden bundle paths found: ${forbidden.join(", ")}.`);
    }

    await runner.run(["codesign", "--verify", "--deep", "--strict", "--verbose=4", appPath]);
    const entitlements = await parsePlist<Record<string, unknown>>(
      await runner.capture(["codesign", "-d", "--entitlements", ":-", appPath]),
      runner,
    );
    assertEqual(
      entitlements["application-identifier"],
      `${config.signing.teamIdentifier}.${config.app.bundleIdentifier}`,
      "Signed application identifier",
    );
    assertEqual(entitlements["get-task-allow"], false, "get-task-allow entitlement");

    const embeddedProfilePath = resolve(appPath, "embedded.mobileprovision");
    const embeddedProfile = await decodeProvisioningProfile(
      await runner.capture(["security", "cms", "-D", "-i", embeddedProfilePath]),
      embeddedProfilePath,
      runner,
    );
    if (!embeddedProfile) throw new Error("The embedded provisioning profile is not Ad Hoc.");
    assertEqual(embeddedProfile.uuid, options.profile.uuid, "Embedded profile UUID");
    assertEqual(
      embeddedProfile.bundleIdentifier,
      config.app.bundleIdentifier,
      "Profile application identifier",
    );
    for (const device of options.requiredDevices) {
      if (!embeddedProfile.provisionedDevices.includes(device)) {
        throw new Error(`Embedded profile does not contain required device ${device}.`);
      }
    }

    const summary = await readPlist<Record<string, DistributionEntry[]>>(
      resolve(options.exportPath, "DistributionSummary.plist"),
      runner,
    );
    const distribution = summary[ipaName]?.[0];
    if (!distribution) throw new Error(`DistributionSummary.plist is missing ${ipaName}.`);
    assertEqual(distribution.buildNumber, String(options.build), "Distribution build");
    assertEqual(distribution.versionNumber, options.settings.version, "Distribution version");
    assertEqual(distribution.architectures?.join(" "), "arm64", "Distribution architectures");
    assertEqual(distribution.profile?.UUID, options.profile.uuid, "Distribution profile UUID");

    if (config.verification?.command) {
      await runner.run(
        substituteHookCommand(config.verification.command, {
          appPath,
          outputDir: options.outputDirectory,
          ipaPath,
          archivePath: options.archivePath,
        }),
        { cwd: options.root },
      );
    }

    const size = (await stat(ipaPath)).size;
    const sha256 = await digestFile(ipaPath);
    await writeFile(`${ipaPath}.sha256`, `${sha256}  ${ipaName}\n`);
    return { ipaPath, ipaName, sha256, size, profileUUID: options.profile.uuid };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
