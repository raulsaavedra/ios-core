import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createArchive } from "./archive";
import type { CommandRunner } from "./process";
import { systemRunner } from "./process";
import {
  determineNextBuild,
  parseReleaseReceipt,
  publishedBuilds,
  readCurrentContents,
  validateExplicitBuild,
  verifyArtifactIntegrity,
  writeCurrentRelease,
} from "./receipts";
import { installApplicationService } from "./service";
import type {
  IOSCoreConfig,
  RegisteredApplication,
  ReleaseReceipt,
  ResolvedDistribution,
} from "./types";
import { readApplicationBuildSettings } from "./xcode";

export interface ReleaseOptions {
  build?: number;
}

export interface ReleaseResult {
  receipt: ReleaseReceipt;
  releaseDirectory: string;
  installerURL: string;
}

export interface ReleaseDependencies {
  runner: CommandRunner;
  archive: typeof createArchive;
  installService: typeof installApplicationService;
  fetch: typeof fetch;
  now: () => Date;
}

const defaultDependencies: ReleaseDependencies = {
  runner: systemRunner,
  archive: createArchive,
  installService: installApplicationService,
  fetch,
  now: () => new Date(),
};

export function parseBuildOption(arguments_: string[]): ReleaseOptions {
  if (arguments_.length === 0) return {};
  if (arguments_.length !== 2 || arguments_[0] !== "--build") {
    throw new Error("Expected [--build <number>].");
  }
  const build = Number(arguments_[1]);
  if (!Number.isSafeInteger(build) || build <= 0) {
    throw new Error("Build must be a positive integer.");
  }
  return { build };
}

async function fetchRequired(
  fetcher: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetcher(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} returned ${response.status}.`);
  return response;
}

export async function smokeRelease(options: {
  fetcher?: typeof fetch;
  requestBaseURL: string;
  publicBaseURL: string;
  receipt: ReleaseReceipt;
  includeInstaller: boolean;
}): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const releaseBaseURL = `${options.requestBaseURL}/releases/${options.receipt.build}`;
  const publicReleaseBaseURL = `${options.publicBaseURL}/releases/${options.receipt.build}`;
  const servedReceipt = parseReleaseReceipt(
    await (await fetchRequired(fetcher, `${releaseBaseURL}/release.json`)).json(),
    options.receipt.build,
  );
  if (
    servedReceipt.sha256 !== options.receipt.sha256 ||
    servedReceipt.size !== options.receipt.size ||
    servedReceipt.bundleIdentifier !== options.receipt.bundleIdentifier
  ) {
    throw new Error(`Release ${options.receipt.build} receipt does not match the artifact.`);
  }
  const manifest = await (await fetchRequired(fetcher, `${releaseBaseURL}/manifest.plist`)).text();
  const expectedIPAURL = `${publicReleaseBaseURL}/${options.receipt.ipaRelativePath}`;
  for (const expected of [
    `<string>${options.receipt.bundleIdentifier}</string>`,
    `<string>${options.receipt.build}</string>`,
    `<string>${expectedIPAURL}</string>`,
  ]) {
    if (!manifest.includes(expected)) throw new Error(`Release manifest is missing ${expected}.`);
  }
  const artifactURL = `${releaseBaseURL}/${options.receipt.ipaRelativePath}`;
  const head = await fetchRequired(fetcher, artifactURL, { method: "HEAD" });
  if (head.headers.get("content-length") !== String(options.receipt.size)) {
    throw new Error(`Release ${options.receipt.build} reports the wrong IPA size.`);
  }
  const range = await fetcher(artifactURL, {
    headers: { Range: "bytes=0-0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 1) {
    throw new Error(`Release ${options.receipt.build} does not support IPA byte ranges.`);
  }
  if (options.includeInstaller) {
    const installer = await (await fetchRequired(fetcher, `${options.requestBaseURL}/`)).text();
    if (!installer.includes(`build ${options.receipt.build}`)) {
      throw new Error(`Installer does not advertise Build ${options.receipt.build}.`);
    }
  }
}

async function waitForLocalRelease(
  fetcher: typeof fetch,
  localBaseURL: string,
  publicBaseURL: string,
  receipt: ReleaseReceipt,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await smokeRelease({
        fetcher,
        requestBaseURL: localBaseURL,
        publicBaseURL,
        receipt,
        includeInstaller: false,
      });
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(250);
    }
  }
  throw lastError;
}

async function acquireReleaseLock(releasesRoot: string): Promise<string> {
  const path = resolve(releasesRoot, ".release.lock");
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let owner: { pid?: unknown };
      try {
        owner = JSON.parse(await readFile(resolve(path, "owner.json"), "utf8")) as {
          pid?: unknown;
        };
      } catch {
        throw new Error(`Another release owns ${path}.`);
      }
      if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) {
        throw new Error(`Another release owns ${path}.`);
      }
      try {
        process.kill(owner.pid as number, 0);
        throw new Error(`Another release owns ${path}.`);
      } catch (processError) {
        if ((processError as NodeJS.ErrnoException).code !== "ESRCH") throw processError;
      }
      const stalePath = resolve(
        releasesRoot,
        `.release.lock.stale-${process.pid}-${crypto.randomUUID()}`,
      );
      try {
        await rename(path, stalePath);
        await mkdir(path);
        const staleOwner = owner.pid as number;
        const ownerSegment = `-${staleOwner}-`;
        for (const entry of await readdir(releasesRoot, { withFileTypes: true })) {
          if (
            entry.isDirectory() &&
            entry.name.startsWith(".staging-") &&
            entry.name.includes(ownerSegment)
          ) {
            await rm(resolve(releasesRoot, entry.name), { recursive: true, force: true });
          }
        }
      } finally {
        await rm(stalePath, { recursive: true, force: true });
      }
    } else {
      throw error;
    }
  }
  await writeFile(
    resolve(path, "owner.json"),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return path;
}

function registeredApplication(
  config: IOSCoreConfig,
  distribution: ResolvedDistribution,
): RegisteredApplication {
  return {
    id: config.app.id,
    displayName: config.app.displayName,
    ...(config.app.installerDescription
      ? { installerDescription: config.app.installerDescription }
      : {}),
    bundleIdentifier: config.app.bundleIdentifier,
    releasesRoot: distribution.releasesRoot,
    publicBaseURL: distribution.publicBaseURL,
    localPort: distribution.localPort,
  };
}

async function restoreCurrent(releasesRoot: string, previous: string | undefined): Promise<void> {
  const currentPath = resolve(releasesRoot, "current.json");
  if (previous === undefined) {
    await rm(currentPath, { force: true });
    return;
  }
  const temporaryPath = `${currentPath}.${process.pid}.rollback`;
  await writeFile(temporaryPath, previous);
  await rename(temporaryPath, currentPath);
}

export async function publishRelease(options: {
  config: IOSCoreConfig;
  root: string;
  distribution: ResolvedDistribution;
  release?: ReleaseOptions;
  dependencies?: Partial<ReleaseDependencies>;
}): Promise<ReleaseResult> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  await mkdir(options.distribution.releasesRoot, { recursive: true });
  const lockPath = await acquireReleaseLock(options.distribution.releasesRoot);
  try {
    const existingBuilds = await publishedBuilds(options.distribution.releasesRoot);
    if (options.release?.build !== undefined) {
      validateExplicitBuild(options.release.build, existingBuilds);
    }
    for (const command of options.config.sourceChecks) {
      await dependencies.runner.run(command, { cwd: options.root });
    }

    const settings = await readApplicationBuildSettings(
      options.config,
      options.root,
      dependencies.runner,
    );
    const build = options.release?.build ?? determineNextBuild(settings.build, existingBuilds);
    const releaseDirectory = resolve(options.distribution.releasesRoot, String(build));
    try {
      await stat(releaseDirectory);
      throw new Error(`Release Build ${build} already exists at ${releaseDirectory}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const stagingDirectory = resolve(
      options.distribution.releasesRoot,
      `.staging-${build}-${process.pid}-${crypto.randomUUID()}`,
    );
    let removePublishedDirectory = false;
    try {
      const archive = await dependencies.archive({
        config: options.config,
        root: options.root,
        outputDirectory: stagingDirectory,
        build,
        settings,
        runner: dependencies.runner,
      });
      const ipaRelativePath = relative(stagingDirectory, archive.ipaPath).replaceAll("\\", "/");
      if (ipaRelativePath.startsWith("../") || ipaRelativePath === "..") {
        throw new Error("The exported IPA is outside its staging directory.");
      }
      const receipt: ReleaseReceipt = {
        version: settings.version,
        build,
        bundleIdentifier: options.config.app.bundleIdentifier,
        ipaRelativePath,
        sha256: archive.sha256,
        size: archive.size,
        profileUUID: archive.profileUUID,
        publishedAt: dependencies.now().toISOString(),
      };
      await writeFile(
        resolve(stagingDirectory, "release.json"),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      await rename(stagingDirectory, releaseDirectory);
      removePublishedDirectory = true;

      await verifyArtifactIntegrity(options.distribution.releasesRoot, receipt);

      await dependencies.installService(
        registeredApplication(options.config, options.distribution),
        dependencies.runner,
      );
      const localBaseURL = `http://127.0.0.1:${options.distribution.localPort}`;
      await waitForLocalRelease(
        dependencies.fetch,
        localBaseURL,
        options.distribution.publicBaseURL,
        receipt,
      );

      const previousCurrent = await readCurrentContents(options.distribution.releasesRoot);
      await writeCurrentRelease(options.distribution.releasesRoot, build);
      try {
        await smokeRelease({
          fetcher: dependencies.fetch,
          requestBaseURL: options.distribution.publicBaseURL,
          publicBaseURL: options.distribution.publicBaseURL,
          receipt,
          includeInstaller: true,
        });
      } catch (publicationError) {
        try {
          await restoreCurrent(options.distribution.releasesRoot, previousCurrent);
        } catch (rollbackError) {
          removePublishedDirectory = false;
          throw new AggregateError(
            [publicationError, rollbackError],
            `Release ${build} failed and its current pointer could not be restored.`,
          );
        }
        throw publicationError;
      }

      removePublishedDirectory = false;
      return {
        receipt,
        releaseDirectory,
        installerURL: `${options.distribution.publicBaseURL}/`,
      };
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
      if (removePublishedDirectory) {
        await rm(releaseDirectory, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
