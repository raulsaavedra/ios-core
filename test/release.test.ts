import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ArchiveResult } from "../src/archive";
import { parseBuildOption, publishRelease } from "../src/release";
import type { ReleaseReceipt } from "../src/types";
import { fakeRunner, testConfig } from "./support";

const settings = {
  build: 29,
  version: "2.0.0",
  executableName: "FieldGuide",
  productName: "FieldGuide",
  deploymentTarget: "18.0",
};

function settingsJSON(): string {
  return JSON.stringify([
    {
      target: "FieldGuide",
      buildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: "com.raulsaavedra.fieldguide",
        WRAPPER_EXTENSION: "app",
        CURRENT_PROJECT_VERSION: String(settings.build),
        MARKETING_VERSION: settings.version,
        EXECUTABLE_NAME: settings.executableName,
        PRODUCT_NAME: settings.productName,
        IPHONEOS_DEPLOYMENT_TARGET: settings.deploymentTarget,
      },
    },
  ]);
}

async function fakeArchive(options: {
  outputDirectory: string;
  build?: number;
}): Promise<ArchiveResult> {
  const exportPath = resolve(options.outputDirectory, "export");
  const ipaPath = resolve(exportPath, "FieldGuide.ipa");
  await mkdir(exportPath, { recursive: true });
  await writeFile(ipaPath, "ipa");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update("ipa");
  return {
    outputDirectory: options.outputDirectory,
    archivePath: resolve(options.outputDirectory, "FieldGuide.xcarchive"),
    exportPath,
    ipaPath,
    ipaName: "FieldGuide.ipa",
    sha256: hasher.digest("hex"),
    size: 3,
    profileUUID: "PROFILE",
    settings,
  };
}

function releaseFetch(root: string, failPublicInstaller = false): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
    );
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const receiptMatch = /^\/releases\/(\d+)\/release\.json$/.exec(url.pathname);
    if (receiptMatch) {
      const build = receiptMatch[1];
      if (!build) return new Response("missing", { status: 404 });
      return new Response(await readFile(resolve(root, build, "release.json"), "utf8"), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const manifestMatch = /^\/releases\/(\d+)\/manifest\.plist$/.exec(url.pathname);
    if (manifestMatch) {
      const build = manifestMatch[1];
      if (!build) return new Response("missing", { status: 404 });
      const receipt = JSON.parse(
        await readFile(resolve(root, build, "release.json"), "utf8"),
      ) as ReleaseReceipt;
      return new Response(
        `<string>${receipt.bundleIdentifier}</string><string>${receipt.build}</string><string>https://mac.example.test:8445/releases/${receipt.build}/${receipt.ipaRelativePath}</string>`,
      );
    }
    if (url.pathname.endsWith(".ipa")) {
      if (init?.headers && new Headers(init.headers).has("Range")) {
        return new Response("i", { status: 206, headers: { "Content-Length": "1" } });
      }
      return new Response(method === "HEAD" ? null : "ipa", {
        headers: { "Content-Length": "3" },
      });
    }
    if (url.pathname === "/") {
      if (failPublicInstaller && url.hostname !== "127.0.0.1") {
        return new Response("failed", { status: 500 });
      }
      const current = JSON.parse(await readFile(resolve(root, "current.json"), "utf8")) as {
        build: number;
      };
      return new Response(`build ${current.build}`);
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
}

async function writeHistorical(root: string, build: number): Promise<void> {
  const directory = resolve(root, String(build));
  await mkdir(directory, { recursive: true });
  const receipt: ReleaseReceipt = {
    version: "1.0.0",
    build,
    bundleIdentifier: "com.raulsaavedra.fieldguide",
    ipaRelativePath: "export/FieldGuide.ipa",
    sha256: "b".repeat(64),
    size: 3,
    profileUUID: "OLD",
    publishedAt: "2026-08-13T00:00:00.000Z",
  };
  await writeFile(resolve(directory, "release.json"), `${JSON.stringify(receipt)}\n`);
}

describe("release transaction", () => {
  test("parses strict build overrides", () => {
    expect(parseBuildOption([])).toEqual({});
    expect(parseBuildOption(["--build", "30"])).toEqual({ build: 30 });
    expect(() => parseBuildOption(["--build", "0"])).toThrow("positive integer");
    expect(() => parseBuildOption(["--wat"])).toThrow("Expected");
  });

  test("publishes a staged immutable release and promotes current", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-release-"));
    const commands: string[][] = [];
    try {
      const result = await publishRelease({
        config: testConfig(),
        root: "/tmp/Personal Projects/field-guide",
        distribution: {
          releasesRoot: root,
          publicBaseURL: "https://mac.example.test:8445",
          localPort: 38_447,
        },
        dependencies: {
          runner: fakeRunner({
            capture: () => settingsJSON(),
            run: (command) => {
              commands.push([...command]);
            },
          }),
          archive: fakeArchive as never,
          installService: (async () => {}) as never,
          fetch: releaseFetch(root),
          now: () => new Date("2026-08-14T12:00:00.000Z"),
        },
      });
      expect(result.receipt.build).toBe(29);
      expect(JSON.parse(await readFile(resolve(root, "current.json"), "utf8"))).toEqual({
        build: 29,
      });
      expect(await Bun.file(resolve(root, "29/release.json")).exists()).toBeTrue();
      expect(commands).toContainEqual(["bun", "test"]);
      expect(await Bun.file(resolve(root, ".release.lock")).exists()).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores the exact previous pointer and removes an unpromoted public failure", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-rollback-"));
    try {
      await writeHistorical(root, 29);
      const previous = '{\n  "build": 29\n}\n';
      await writeFile(resolve(root, "current.json"), previous);
      await expect(
        publishRelease({
          config: testConfig(),
          root: "/tmp/app",
          distribution: {
            releasesRoot: root,
            publicBaseURL: "https://mac.example.test:8445",
            localPort: 38_447,
          },
          dependencies: {
            runner: fakeRunner({ capture: () => settingsJSON() }),
            archive: fakeArchive as never,
            installService: (async () => {}) as never,
            fetch: releaseFetch(root, true),
          },
        }),
      ).rejects.toThrow("returned 500");
      expect(await readFile(resolve(root, "current.json"), "utf8")).toBe(previous);
      expect(await Bun.file(resolve(root, "30")).exists()).toBeFalse();
      expect(await Bun.file(resolve(root, ".release.lock")).exists()).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects explicit history before source checks", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-explicit-"));
    let sourceChecks = 0;
    try {
      await writeHistorical(root, 29);
      await expect(
        publishRelease({
          config: testConfig(),
          root: "/tmp/app",
          distribution: {
            releasesRoot: root,
            publicBaseURL: "https://mac.example.test:8445",
            localPort: 38_447,
          },
          release: { build: 28 },
          dependencies: {
            runner: fakeRunner({
              capture: () => settingsJSON(),
              run: () => {
                sourceChecks += 1;
              },
            }),
          },
        }),
      ).rejects.toThrow("greater than");
      expect(sourceChecks).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prevents concurrent publishers with an atomic lock", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-lock-"));
    try {
      await mkdir(resolve(root, ".release.lock"));
      await expect(
        publishRelease({
          config: testConfig(),
          root: "/tmp/app",
          distribution: {
            releasesRoot: root,
            publicBaseURL: "https://mac.example.test:8445",
            localPort: 38_447,
          },
        }),
      ).rejects.toThrow("Another release owns");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers a release lock owned by a dead process", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-stale-lock-"));
    try {
      const lock = resolve(root, ".release.lock");
      await mkdir(lock);
      await writeFile(
        resolve(lock, "owner.json"),
        `${JSON.stringify({ pid: 2_147_483_647, startedAt: "2020-01-01T00:00:00Z" })}\n`,
      );
      const result = await publishRelease({
        config: testConfig(),
        root: "/tmp/app",
        distribution: {
          releasesRoot: root,
          publicBaseURL: "https://mac.example.test:8445",
          localPort: 38_447,
        },
        dependencies: {
          runner: fakeRunner({ capture: () => settingsJSON() }),
          archive: fakeArchive as never,
          installService: (async () => {}) as never,
          fetch: releaseFetch(root),
        },
      });
      expect(result.receipt.build).toBe(29);
      expect(await Bun.file(lock).exists()).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans staging and the lock when a source gate fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-source-fail-"));
    try {
      await expect(
        publishRelease({
          config: testConfig(),
          root: "/tmp/app",
          distribution: {
            releasesRoot: root,
            publicBaseURL: "https://mac.example.test:8445",
            localPort: 38_447,
          },
          dependencies: {
            runner: fakeRunner({
              capture: () => settingsJSON(),
              run: () => {
                throw new Error("source gate failed");
              },
            }),
          },
        }),
      ).rejects.toThrow("source gate failed");
      expect(await Bun.file(resolve(root, ".release.lock")).exists()).toBeFalse();
      expect((await readdirNames(root)).some((name) => name.startsWith(".staging-"))).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function readdirNames(path: string): Promise<string[]> {
  const directory = await import("node:fs/promises");
  return directory.readdir(path);
}
