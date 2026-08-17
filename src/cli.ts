#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createArchive } from "./archive";
import {
  loadConfig,
  loadReleaseEnvironment,
  resolveDistribution,
  resolveExpoProjectRoot,
} from "./config";
import {
  createNativeFingerprint,
  expoCommand,
  expoRunIOSCommand,
  expoStartCommand,
  nativeBuildRequired,
  prebuildExpoProject,
  readExpoNativeProject,
  readExpoProjectSettings,
  resolveDevelopmentDevice,
  storeNativeFingerprint,
} from "./expo";
import { systemRunner } from "./process";
import {
  assertSigningIdentity,
  discoverProvisioningProfile,
  parseRequiredDeviceUDIDs,
} from "./profiles";
import { parseBuildOption, publishRelease } from "./release";
import {
  installApplicationService,
  isServiceRunning,
  readServiceRegistry,
  serviceStateRoot,
} from "./service";
import type { RegisteredApplication } from "./types";
import { verifyExport } from "./verifier";

function usage(): never {
  throw new Error(`Usage:
  ios-core dev [--device <name-or-udid>] [--host lan|localhost|tunnel] [--port <number>]
  ios-core fingerprint
  ios-core prebuild
  ios-core archive [--output <directory>] [--build <number>]
  ios-core verify --output <directory> [--build <number>]
  ios-core release [--build <number>]
  ios-core service install
  ios-core service status`);
}

function readOption(arguments_: string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function assertAllowedArguments(arguments_: string[], flags: string[]): void {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) continue;
    if (!flags.includes(argument)) usage();
    index += 1;
  }
}

function parseArchiveOptions(arguments_: string[]): { output?: string; build?: number } {
  assertAllowedArguments(arguments_, ["--output", "--build"]);
  const output = readOption(arguments_, "--output");
  const buildValue = readOption(arguments_, "--build");
  if (!output && !buildValue) return {};
  if (buildValue === undefined) return output ? { output } : {};
  const build = Number(buildValue);
  if (!Number.isSafeInteger(build) || build <= 0) {
    throw new Error("Build must be a positive integer.");
  }
  return { ...(output ? { output } : {}), build };
}

function parseDevOptions(arguments_: string[]): {
  device?: string;
  host?: "lan" | "localhost" | "tunnel";
  port?: number;
} {
  assertAllowedArguments(arguments_, ["--device", "--host", "--port"]);
  const device = readOption(arguments_, "--device");
  const hostValue = readOption(arguments_, "--host");
  if (
    hostValue !== undefined &&
    hostValue !== "lan" &&
    hostValue !== "localhost" &&
    hostValue !== "tunnel"
  ) {
    throw new Error("Host must be lan, localhost, or tunnel.");
  }
  const portValue = readOption(arguments_, "--port");
  if (portValue === undefined)
    return { ...(device ? { device } : {}), ...(hostValue ? { host: hostValue } : {}) };
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Port must be a valid TCP port.");
  }
  return {
    ...(device ? { device } : {}),
    ...(hostValue ? { host: hostValue } : {}),
    port,
  };
}

function serviceApplication(loaded: Awaited<ReturnType<typeof loadConfig>>): RegisteredApplication {
  const distribution = resolveDistribution(loaded.config, loaded.root);
  return {
    id: loaded.config.app.id,
    displayName: loaded.config.app.displayName,
    ...(loaded.config.app.installerDescription
      ? { installerDescription: loaded.config.app.installerDescription }
      : {}),
    bundleIdentifier: loaded.config.app.bundleIdentifier,
    releasesRoot: distribution.releasesRoot,
    publicBaseURL: distribution.publicBaseURL,
    localPort: distribution.localPort,
  };
}

async function runDev(arguments_: string[]): Promise<void> {
  const loaded = await loadConfig();
  const options = parseDevOptions(arguments_);
  const projectRoot = resolveExpoProjectRoot(loaded.config, loaded.root);
  const command = await expoCommand(loaded.config, loaded.root, projectRoot);
  const native = await nativeBuildRequired(loaded.config, loaded.root);
  if (native.required) {
    const device = resolveDevelopmentDevice(options.device);
    if (!device) {
      throw new Error(
        "The development client needs rebuilding. Pass --device or set IOS_CORE_DEV_DEVICE so ios-core never launches Simulator implicitly.",
      );
    }
    console.log("Native Expo project changed; rebuilding the local development client.");
    await prebuildExpoProject(loaded.config, loaded.root);
    await systemRunner.run(
      expoRunIOSCommand(command, {
        device,
        noBundler: true,
      }),
      {
        cwd: projectRoot,
      },
    );
    await storeNativeFingerprint(
      loaded.config,
      loaded.root,
      await createNativeFingerprint(loaded.config, loaded.root),
    );
  }
  await systemRunner.run(expoStartCommand(command, options), { cwd: projectRoot });
}

async function verifyDirectory(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  outputDirectory: string,
  buildOverride: number | undefined,
): Promise<void> {
  const nativeProject = await readExpoNativeProject(loaded.config, loaded.root);
  const settings = await readExpoProjectSettings(
    loaded.config,
    loaded.root,
    nativeProject,
    systemRunner,
  );
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const archives = entries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".xcarchive"),
  );
  if (archives.length !== 1 || !archives[0]) {
    throw new Error(`Expected one xcarchive in ${outputDirectory}.`);
  }
  const requiredDevices = parseRequiredDeviceUDIDs();
  await assertSigningIdentity(loaded.config.signing.identity ?? "Apple Distribution", systemRunner);
  const profile = await discoverProvisioningProfile(
    {
      bundleIdentifier: loaded.config.app.bundleIdentifier,
      teamIdentifier: loaded.config.signing.teamIdentifier,
      requiredDevices,
    },
    systemRunner,
  );
  const result = await verifyExport({
    config: loaded.config,
    root: loaded.root,
    outputDirectory,
    archivePath: resolve(outputDirectory, archives[0].name),
    exportPath: resolve(outputDirectory, "export"),
    build: buildOverride ?? settings.build,
    settings,
    profile,
    requiredDevices,
    runner: systemRunner,
  });
  console.log(`Verified ${result.ipaName} (${result.sha256}).`);
}

async function main(): Promise<void> {
  await loadReleaseEnvironment();
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "dev") {
    await runDev(arguments_);
    return;
  }
  if (command === "fingerprint") {
    if (arguments_.length !== 0) usage();
    const loaded = await loadConfig();
    const fingerprint = await createNativeFingerprint(loaded.config, loaded.root);
    console.log(fingerprint);
    return;
  }
  if (command === "prebuild") {
    if (arguments_.length !== 0) usage();
    const loaded = await loadConfig();
    await prebuildExpoProject(loaded.config, loaded.root);
    console.log(
      `Generated Expo iOS project in ${resolveExpoProjectRoot(loaded.config, loaded.root)}/ios.`,
    );
    return;
  }
  if (command === "archive") {
    const parsed = parseArchiveOptions(arguments_);
    const loaded = await loadConfig();
    const stamp = new Date()
      .toISOString()
      .replaceAll(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    const outputDirectory = resolve(
      parsed.output ?? resolve(homedir(), "Builds", loaded.config.app.id, `expo-${stamp}`),
    );
    const result = await createArchive({
      config: loaded.config,
      root: loaded.root,
      outputDirectory,
      ...(parsed.build ? { build: parsed.build } : {}),
    });
    console.log(`Archive: ${result.archivePath}`);
    console.log(`IPA: ${result.ipaPath}`);
    return;
  }
  if (command === "verify") {
    assertAllowedArguments(arguments_, ["--output", "--build"]);
    const output = readOption(arguments_, "--output");
    if (!output) usage();
    const buildValue = readOption(arguments_, "--build");
    const build = buildValue === undefined ? undefined : Number(buildValue);
    if (build !== undefined && (!Number.isSafeInteger(build) || build <= 0)) {
      throw new Error("Build must be a positive integer.");
    }
    const loaded = await loadConfig();
    await verifyDirectory(loaded, resolve(output), build);
    return;
  }
  if (command === "release") {
    const loaded = await loadConfig();
    const result = await publishRelease({
      config: loaded.config,
      root: loaded.root,
      distribution: resolveDistribution(loaded.config, loaded.root),
      release: parseBuildOption(arguments_),
    });
    console.log(
      `Released ${loaded.config.app.displayName} ${result.receipt.version} (${result.receipt.build})`,
    );
    console.log(`Installer: ${result.installerURL}`);
    return;
  }
  if (command === "service" && arguments_.length === 1 && arguments_[0] === "install") {
    const loaded = await loadConfig();
    await installApplicationService(serviceApplication(loaded));
    console.log(`${loaded.config.app.displayName} registered with ios-core.`);
    return;
  }
  if (command === "service" && arguments_.length === 1 && arguments_[0] === "status") {
    const registry = await readServiceRegistry(resolve(serviceStateRoot(), "registry.json"));
    console.log(
      isServiceRunning() ? "ios-core service is running." : "ios-core service is stopped.",
    );
    const endpoint = registry.applications[0]?.publicBaseURL;
    if (endpoint) {
      console.log(`Installer catalog: ${endpoint}/`);
      for (const application of registry.applications) {
        console.log(`${application.displayName}: ${endpoint}/apps/${application.id}/`);
      }
    }
    return;
  }
  usage();
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
