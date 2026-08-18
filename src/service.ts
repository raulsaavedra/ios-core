import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { startGlobalServer } from "./ota";
import type { CommandRunner } from "./process";
import { systemRunner } from "./process";
import { writeJSONAtomic } from "./receipts";
import type { RegisteredApplication, ServiceRegistry } from "./types";

const PACKAGE_VERSION = "0.3.0";
const LABEL = "com.raulsaavedra.ios-core";

interface RuntimeReceipt {
  schemaVersion: 1;
  packageVersion: string;
  sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serviceStateRoot(): string {
  return process.env.IOS_CORE_STATE_ROOT ?? resolve(homedir(), ".local/share/ios-core");
}

export function parseServiceRegistry(
  value: unknown,
  options: { allowEndpointMigration?: boolean } = {},
): ServiceRegistry {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.applications)) {
    throw new Error("Invalid ios-core service registry.");
  }
  const applications = value.applications as RegisteredApplication[];
  for (const application of applications) {
    if (
      !isRecord(application) ||
      typeof application.id !== "string" ||
      typeof application.displayName !== "string" ||
      typeof application.bundleIdentifier !== "string" ||
      typeof application.releasesRoot !== "string" ||
      typeof application.publicBaseURL !== "string" ||
      new URL(application.publicBaseURL).protocol !== "https:" ||
      !Number.isSafeInteger(application.localPort) ||
      application.localPort < 1 ||
      application.localPort > 65_535 ||
      (application.installerDescription !== undefined &&
        typeof application.installerDescription !== "string")
    ) {
      throw new Error("Invalid application in ios-core service registry.");
    }
  }
  const canonical = applications.map(canonicalApplication);
  validateRegistryCollisions(canonical, options.allowEndpointMigration ?? false);
  return {
    schemaVersion: 1,
    applications: canonical.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function validateRegistryCollisions(
  applications: RegisteredApplication[],
  allowEndpointMigration = false,
): void {
  const uniqueFields: Array<
    keyof Pick<RegisteredApplication, "id" | "bundleIdentifier" | "releasesRoot">
  > = ["id", "bundleIdentifier", "releasesRoot"];
  for (const field of uniqueFields) {
    const values = new Set<string | number>();
    for (const application of applications) {
      const value = application[field];
      if (values.has(value)) throw new Error(`Duplicate service application ${field}: ${value}.`);
      values.add(value);
    }
  }
  const endpoints = new Set(
    applications.map((application) => `${application.publicBaseURL}\n${application.localPort}`),
  );
  if (!allowEndpointMigration && endpoints.size > 1) {
    throw new Error("All service applications must use the shared installer endpoint.");
  }
}

function canonicalApplication(application: RegisteredApplication): RegisteredApplication {
  let releasesRoot: string;
  try {
    releasesRoot = realpathSync.native(application.releasesRoot);
  } catch {
    releasesRoot = resolve(application.releasesRoot);
  }
  return {
    ...application,
    releasesRoot,
    publicBaseURL: application.publicBaseURL.replace(/\/$/, ""),
  };
}

export function registerApplication(
  registry: ServiceRegistry,
  application: RegisteredApplication,
): ServiceRegistry {
  const normalized = canonicalApplication(application);
  const applications = registry.applications
    .map(canonicalApplication)
    .filter((candidate) => candidate.id !== normalized.id)
    .map((candidate) => ({
      ...candidate,
      publicBaseURL: normalized.publicBaseURL,
      localPort: normalized.localPort,
    }));
  applications.push(normalized);
  validateRegistryCollisions(applications);
  return { schemaVersion: 1, applications: applications.sort((a, b) => a.id.localeCompare(b.id)) };
}

export async function readServiceRegistry(path: string): Promise<ServiceRegistry> {
  try {
    return parseServiceRegistry(JSON.parse(await readFile(path, "utf8")), {
      allowEndpointMigration: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, applications: [] };
    }
    throw error;
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) throw new Error(`Invalid ios-core package version: ${value}.`);
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function sha256(contents: Uint8Array): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(contents);
  return hasher.digest("hex");
}

export async function buildServiceRuntime(stateRoot = serviceStateRoot()): Promise<string> {
  const runtimeDirectory = resolve(stateRoot, "runtime");
  const runtimePath = resolve(runtimeDirectory, "service.js");
  const receiptPath = resolve(runtimeDirectory, "receipt.json");
  await mkdir(runtimeDirectory, { recursive: true });
  let installed: RuntimeReceipt | undefined;
  try {
    installed = JSON.parse(await readFile(receiptPath, "utf8")) as RuntimeReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (installed) {
    const versionOrder = compareVersions(installed.packageVersion, PACKAGE_VERSION);
    let installedRuntime: Uint8Array | undefined;
    try {
      installedRuntime = await readFile(runtimePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (installedRuntime) {
      if ((await sha256(installedRuntime)) !== installed.sha256) {
        throw new Error("The installed ios-core service runtime does not match its receipt.");
      }
      if (versionOrder >= 0) return runtimePath;
    } else if (versionOrder > 0) {
      throw new Error(`Installed ios-core ${installed.packageVersion} runtime is missing.`);
    }
  }
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "service-entry.ts")],
    format: "esm",
    minify: false,
    target: "bun",
  });
  if (!build.success || build.outputs.length !== 1) {
    throw new Error(`Failed to build ios-core service runtime: ${build.logs.join("\n")}`);
  }
  const output = build.outputs[0];
  if (!output) throw new Error("ios-core service runtime build produced no output.");
  const contents = new Uint8Array(await output.arrayBuffer());
  const digest = await sha256(contents);
  const temporaryRuntime = `${runtimePath}.${process.pid}.tmp`;
  await writeFile(temporaryRuntime, contents);
  await rename(temporaryRuntime, runtimePath);
  await writeJSONAtomic(receiptPath, {
    schemaVersion: 1,
    packageVersion: PACKAGE_VERSION,
    sha256: digest,
  } satisfies RuntimeReceipt);
  return runtimePath;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderLaunchAgent(options: {
  bunPath: string;
  registryPath: string;
  runtimePath: string;
  stateRoot: string;
}): string {
  const arguments_ = [options.bunPath, options.runtimePath, "--registry", options.registryPath];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${arguments_.map((argument) => `<string>${xmlEscape(argument)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xmlEscape(options.stateRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Background</string>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(resolve(options.stateRoot, "service.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(resolve(options.stateRoot, "service.error.log"))}</string>
</dict>
</plist>
`;
}

function serviceTarget(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("ios-core service installation requires a user domain.");
  return `user/${uid}/${LABEL}`;
}

async function activateLaunchAgent(plistPath: string, runner: CommandRunner): Promise<void> {
  const target = serviceTarget();
  if (runner.succeeds(["launchctl", "print", target])) {
    await runner.run(["launchctl", "bootout", target]);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!runner.succeeds(["launchctl", "print", target])) break;
      await Bun.sleep(50);
      if (attempt === 39) throw new Error(`LaunchAgent did not unload: ${target}.`);
    }
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("ios-core service installation requires a user domain.");
  const domain = `user/${uid}`;
  let bootstrapError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await runner.run(["launchctl", "bootstrap", domain, plistPath]);
      bootstrapError = undefined;
      break;
    } catch (error) {
      bootstrapError = error;
      if (attempt < 4) await Bun.sleep(200);
    }
  }
  if (bootstrapError !== undefined) throw bootstrapError;
  await runner.run(["launchctl", "kickstart", "-k", target]);
}

export async function probeServiceApplications(
  applications: RegisteredApplication[],
  fetcher: typeof fetch = fetch,
  attempts = 40,
  sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
): Promise<void> {
  const application = applications[0];
  if (!application) return;
  const expected = applications
    .map(({ id, bundleIdentifier }) => ({ appId: id, bundleIdentifier }))
    .sort((left, right) => left.appId.localeCompare(right.appId));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(`http://127.0.0.1:${application.localPort}/healthz`, {
        method: "HEAD",
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`Health endpoint returned ${response.status}.`);
      const identityResponse = await fetcher(`http://127.0.0.1:${application.localPort}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!identityResponse.ok) {
        throw new Error(`Health identity endpoint returned ${identityResponse.status}.`);
      }
      const identity = (await identityResponse.json()) as {
        applications?: unknown;
      };
      const reported = Array.isArray(identity.applications)
        ? identity.applications
            .filter(
              (candidate): candidate is { appId: string; bundleIdentifier: string } =>
                isRecord(candidate) &&
                typeof candidate.appId === "string" &&
                typeof candidate.bundleIdentifier === "string",
            )
            .map(({ appId, bundleIdentifier }) => ({ appId, bundleIdentifier }))
            .sort((left, right) => left.appId.localeCompare(right.appId))
        : undefined;
      if (JSON.stringify(reported) !== JSON.stringify(expected)) {
        throw new Error(`Port ${application.localPort} reported the wrong service registry.`);
      }
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  if (lastError !== undefined) {
    throw new Error(`ios-core service listener did not start on port ${application.localPort}.`, {
      cause: lastError,
    });
  }
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function restoreFile(path: string, contents: Uint8Array | undefined): Promise<void> {
  if (contents === undefined) {
    await rm(path, { force: true });
  } else {
    await writeFile(path, contents);
  }
}

export async function installApplicationService(
  application: RegisteredApplication,
  runner: CommandRunner = systemRunner,
  stateRoot = serviceStateRoot(),
  options: {
    launchAgentsDirectory?: string;
    fetcher?: typeof fetch;
    probeAttempts?: number;
    sleep?: (milliseconds: number) => Promise<unknown>;
  } = {},
): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  const launchAgentsDirectory =
    options.launchAgentsDirectory ?? resolve(homedir(), "Library/LaunchAgents");
  await mkdir(launchAgentsDirectory, { recursive: true });
  const registryPath = resolve(stateRoot, "registry.json");
  const runtimePath = resolve(stateRoot, "runtime/service.js");
  const runtimeReceiptPath = resolve(stateRoot, "runtime/receipt.json");
  const plistPath = resolve(launchAgentsDirectory, `${LABEL}.plist`);
  const registry = registerApplication(await readServiceRegistry(registryPath), application);
  const previous = {
    registry: await readOptional(registryPath),
    runtime: await readOptional(runtimePath),
    runtimeReceipt: await readOptional(runtimeReceiptPath),
    plist: await readOptional(plistPath),
  };
  try {
    await buildServiceRuntime(stateRoot);
    await writeJSONAtomic(registryPath, registry);
    await writeFile(
      plistPath,
      renderLaunchAgent({ bunPath: process.execPath, registryPath, runtimePath, stateRoot }),
    );
    await runner.run(["plutil", "-lint", plistPath]);
    await activateLaunchAgent(plistPath, runner);
    await probeServiceApplications(
      registry.applications,
      options.fetcher,
      options.probeAttempts,
      options.sleep,
    );
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      if (runner.succeeds(["launchctl", "print", serviceTarget()])) {
        await runner.run(["launchctl", "bootout", serviceTarget()]);
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      await Promise.all([
        restoreFile(registryPath, previous.registry),
        restoreFile(runtimePath, previous.runtime),
        restoreFile(runtimeReceiptPath, previous.runtimeReceipt),
        restoreFile(plistPath, previous.plist),
      ]);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (previous.plist) {
      try {
        await activateLaunchAgent(plistPath, runner);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "ios-core service installation and rollback both failed.",
      );
    }
    throw error;
  }
}

export function isServiceRunning(runner: CommandRunner = systemRunner): boolean {
  return runner.succeeds(["launchctl", "print", serviceTarget()]);
}

export function startRegisteredApplications(
  registry: ServiceRegistry,
): ReturnType<typeof Bun.serve>[] {
  return [startGlobalServer(registry)];
}
