#!/usr/bin/env bun

import { homedir } from "node:os";
import { resolve } from "node:path";
import { createArchive } from "./archive";
import { loadConfig, loadReleaseEnvironment, resolveDistribution } from "./config";
import { parseBuildOption, publishRelease } from "./release";
import {
  installApplicationService,
  isServiceRunning,
  readServiceRegistry,
  serviceStateRoot,
} from "./service";
import type { RegisteredApplication } from "./types";

function usage(): never {
  throw new Error(`Usage:
  ios-core archive [--output <directory>] [--build <number>]
  ios-core release [--build <number>]
  ios-core service install
  ios-core service status`);
}

function parseArchiveOptions(arguments_: string[]): { output?: string; build?: number } {
  const result: { output?: string; build?: number } = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) usage();
    if (flag === "--output") result.output = value;
    else if (flag === "--build") {
      const build = Number(value);
      if (!Number.isSafeInteger(build) || build <= 0) {
        throw new Error("Build must be a positive integer.");
      }
      result.build = build;
    } else usage();
  }
  return result;
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

async function main(): Promise<void> {
  await loadReleaseEnvironment();
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "archive") {
    const parsed = parseArchiveOptions(arguments_);
    const loaded = await loadConfig();
    const stamp = new Date()
      .toISOString()
      .replaceAll(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    const outputDirectory = resolve(
      parsed.output ?? resolve(homedir(), "Builds", loaded.config.app.id, `native-${stamp}`),
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
