import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  determineNextBuild,
  isSafeRelativePath,
  parseReleaseReceipt,
  validateExplicitBuild,
  verifyArtifactIntegrity,
  writeCurrentRelease,
} from "../src/receipts";
import {
  buildServiceRuntime,
  installApplicationService,
  parseServiceRegistry,
  probeServiceApplications,
  registerApplication,
  renderLaunchAgent,
} from "../src/service";
import type { RegisteredApplication, ReleaseReceipt } from "../src/types";

function application(overrides: Partial<RegisteredApplication> = {}): RegisteredApplication {
  return {
    id: "field-guide",
    displayName: "Field Guide",
    bundleIdentifier: "com.raulsaavedra.fieldguide",
    releasesRoot: "/tmp/releases",
    publicBaseURL: "https://mac.example.test:8445",
    localPort: 38_447,
    ...overrides,
  };
}

function receipt(overrides: Partial<ReleaseReceipt> = {}): ReleaseReceipt {
  return {
    version: "2.0.0",
    build: 29,
    bundleIdentifier: "com.raulsaavedra.fieldguide",
    ipaRelativePath: "export/FieldGuide.ipa",
    sha256: "a".repeat(64),
    size: 42,
    profileUUID: "PROFILE",
    publishedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("release receipts", () => {
  test("parses safe complete receipts and rejects path escapes", () => {
    expect(parseReleaseReceipt(receipt(), 29)).toEqual(receipt());
    expect(isSafeRelativePath("export/App.ipa")).toBeTrue();
    for (const path of ["/App.ipa", "../App.ipa", "export\\App.ipa", "export//App.ipa"]) {
      expect(isSafeRelativePath(path)).toBeFalse();
      expect(() => parseReleaseReceipt(receipt({ ipaRelativePath: path }))).toThrow();
    }
  });

  test("allocates above source and immutable history", () => {
    expect(determineNextBuild(27, [])).toBe(27);
    expect(determineNextBuild(27, [27, 28, 29])).toBe(30);
    expect(determineNextBuild(35, [29])).toBe(35);
    expect(() => validateExplicitBuild(29, [28, 29])).toThrow("already published");
    expect(() => validateExplicitBuild(28, [29])).toThrow("greater than");
  });

  test("atomically replaces the current pointer", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-current-"));
    try {
      await writeCurrentRelease(root, 29);
      await writeCurrentRelease(root, 30);
      expect(JSON.parse(await readFile(resolve(root, "current.json"), "utf8"))).toEqual({
        build: 30,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("multi-app service", () => {
  test("preserves siblings, moves them to the shared endpoint, and rejects identity collisions", () => {
    const initial = { schemaVersion: 1 as const, applications: [application()] };
    const fitness = application({
      id: "fitness",
      displayName: "Fitness",
      bundleIdentifier: "com.raulsaavedra.fitness",
      releasesRoot: "/tmp/fitness-releases",
      publicBaseURL: "https://mac.example.test:8446",
      localPort: 38_446,
    });
    const registered = registerApplication(initial, fitness);
    expect(registered.applications.map((app) => app.id)).toEqual(["field-guide", "fitness"]);
    expect(registered.applications.every((app) => app.localPort === 38_446)).toBeTrue();
    expect(
      registered.applications.every((app) => app.publicBaseURL === "https://mac.example.test:8446"),
    ).toBeTrue();
    expect(() =>
      registerApplication(
        initial,
        application({
          id: "other",
          bundleIdentifier: "com.raulsaavedra.other",
          publicBaseURL: "https://mac.example.test:8447",
          localPort: 38_448,
          releasesRoot: "/tmp/../tmp/releases",
        }),
      ),
    ).toThrow("releasesRoot");
  });

  test("rehashes an artifact before it can be accepted for promotion", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-integrity-"));
    const release = receipt({ size: 3 });
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update("ipa");
    release.sha256 = hasher.digest("hex");
    try {
      await mkdir(resolve(root, "29/export"), { recursive: true });
      await writeFile(resolve(root, "29/export/FieldGuide.ipa"), "ipa");
      expect(await verifyArtifactIntegrity(root, release)).toBe(
        resolve(root, "29/export/FieldGuide.ipa"),
      );
      await writeFile(resolve(root, "29/export/FieldGuide.ipa"), "bad");
      await expect(verifyArtifactIntegrity(root, release)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("validates registry shape and HTTPS endpoints", () => {
    expect(parseServiceRegistry({ schemaVersion: 1, applications: [application()] })).toEqual({
      schemaVersion: 1,
      applications: [application()],
    });
    expect(() =>
      parseServiceRegistry({
        schemaVersion: 1,
        applications: [application({ publicBaseURL: "http://example.test" })],
      }),
    ).toThrow("Invalid application");
    expect(() =>
      parseServiceRegistry({
        schemaVersion: 1,
        applications: [
          application(),
          application({
            id: "fitness",
            bundleIdentifier: "com.raulsaavedra.fitness",
            releasesRoot: "/tmp/fitness-releases",
            publicBaseURL: "https://mac.example.test:8446",
            localPort: 38_446,
          }),
        ],
      }),
    ).toThrow("shared installer endpoint");
  });

  test("renders absolute package-managed LaunchAgent paths", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios core state "));
    const plistPath = resolve(root, "agent.plist");
    try {
      const plist = renderLaunchAgent({
        bunPath: "/opt/homebrew/bin/bun",
        runtimePath: resolve(root, "runtime/service.js"),
        registryPath: resolve(root, "registry.json"),
        stateRoot: root,
      });
      await writeFile(plistPath, plist);
      expect(plist).toContain("com.raulsaavedra.ios-core");
      expect(plist).toContain("LimitLoadToSessionType");
      expect(plist).toContain("<string>Background</string>");
      expect(plist).not.toContain("node_modules");
      expect(Bun.spawnSync(["plutil", "-lint", plistPath]).exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("builds a standalone service runtime outside the package checkout", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-runtime-"));
    try {
      const runtimePath = await buildServiceRuntime(root);
      expect(await Bun.file(runtimePath).exists()).toBeTrue();
      expect(await buildServiceRuntime(root)).toBe(runtimePath);
      expect(
        JSON.parse(await readFile(resolve(root, "runtime/receipt.json"), "utf8")),
      ).toMatchObject({
        schemaVersion: 1,
        packageVersion: "0.4.1",
      });
      await writeFile(runtimePath, "tampered");
      await expect(buildServiceRuntime(root)).rejects.toThrow("does not match its receipt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries listener health until the copied service answers", async () => {
    let requests = 0;
    await probeServiceApplications(
      [application()],
      (async (_input: unknown, init?: RequestInit) => {
        requests += 1;
        if (requests === 1) throw new Error("not ready");
        if (init?.method === "HEAD") return new Response(null);
        return Response.json({
          ok: true,
          applications: [{ appId: "field-guide", bundleIdentifier: "com.raulsaavedra.fieldguide" }],
        });
      }) as unknown as typeof fetch,
      2,
      async () => {},
    );
    expect(requests).toBe(3);
  });

  test("accepts a bootstrap error when launchd has registered the service", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-service-bootstrap-race-"));
    const launchAgents = resolve(root, "LaunchAgents");
    const commands: string[][] = [];
    let loaded = false;
    let bootstrapAttempts = 0;
    const target = `user/${process.getuid?.()}/com.raulsaavedra.ios-core`;
    const runner = {
      async capture() {
        return "";
      },
      async run(command: readonly [string, ...string[]]) {
        commands.push([...command]);
        if (command[1] === "bootstrap") {
          bootstrapAttempts += 1;
          loaded = true;
          throw new Error("launchctl bootstrap exited with code 5: Input/output error");
        }
      },
      succeeds(command: readonly [string, ...string[]]) {
        return command[1] === "print" && loaded;
      },
    };
    try {
      await installApplicationService(application(), runner, root, {
        launchAgentsDirectory: launchAgents,
        probeAttempts: 1,
        sleep: async () => {},
        fetcher: (async (_input: unknown, init?: RequestInit) => {
          if (init?.method === "HEAD") return new Response(null);
          return Response.json({
            ok: true,
            applications: [
              { appId: "field-guide", bundleIdentifier: "com.raulsaavedra.fieldguide" },
            ],
          });
        }) as unknown as typeof fetch,
      });
      expect(bootstrapAttempts).toBe(1);
      expect(commands).toContainEqual(["launchctl", "kickstart", "-k", target]);
      expect(await Bun.file(resolve(root, "registry.json")).exists()).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a healthy listener owned by another application", async () => {
    await expect(
      probeServiceApplications(
        [application()],
        (async (_input: unknown, init?: RequestInit) => {
          if (init?.method === "HEAD") return new Response(null);
          return Response.json({
            ok: true,
            appId: "legacy-server",
            bundleIdentifier: "com.example.legacy",
          });
        }) as unknown as typeof fetch,
        1,
        async () => {},
      ),
    ).rejects.toThrow("service listener did not start");
  });

  test("boots out a partially loaded first install and removes its files", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-service-install-"));
    const launchAgents = resolve(root, "LaunchAgents");
    let loaded = false;
    const commands: string[][] = [];
    const runner = {
      async capture() {
        return "";
      },
      async run(command: readonly [string, ...string[]]) {
        commands.push([...command]);
        if (command[1] === "bootstrap") loaded = true;
        if (command[1] === "kickstart") throw new Error("kickstart failed");
        if (command[1] === "bootout") loaded = false;
      },
      succeeds(command: readonly [string, ...string[]]) {
        return command[1] === "print" && loaded;
      },
    };
    try {
      await expect(
        installApplicationService(application(), runner, root, {
          launchAgentsDirectory: launchAgents,
          probeAttempts: 1,
          sleep: async () => {},
        }),
      ).rejects.toThrow("kickstart failed");
      expect(loaded).toBeFalse();
      expect(commands.some((command) => command[1] === "bootout")).toBeTrue();
      expect(commands.some((command) => command.includes(`user/${process.getuid?.()}`))).toBeTrue();
      expect(await Bun.file(resolve(root, "registry.json")).exists()).toBeFalse();
      expect(await Bun.file(resolve(root, "runtime/service.js")).exists()).toBeFalse();
      expect(
        await Bun.file(resolve(launchAgents, "com.raulsaavedra.ios-core.plist")).exists(),
      ).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
