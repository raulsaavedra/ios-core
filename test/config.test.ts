import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { findConfigPath, loadConfig, resolveDistribution, validateConfig } from "../src/config";
import { testConfig } from "./support";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("configuration", () => {
  test("validates a complete project config", () => {
    expect(validateConfig(testConfig())).toEqual(testConfig());
  });

  test("accepts a workspace instead of a project", () => {
    const config = testConfig({
      xcode: { workspace: "apps/ios/App.xcworkspace", scheme: "App" },
    });
    expect(validateConfig(config).xcode.workspace).toBe("apps/ios/App.xcworkspace");
  });

  test("rejects container ambiguity, insecure distribution, bad ports, and unknown keys", () => {
    const ambiguous = {
      ...testConfig(),
      xcode: { project: "App.xcodeproj", workspace: "App.xcworkspace", scheme: "App" },
    };
    expect(() => validateConfig(ambiguous)).toThrow("exactly one");
    expect(() =>
      validateConfig(
        testConfig({ distribution: { publicBaseURL: "http://example.test", localPort: 1 } }),
      ),
    ).toThrow("HTTPS");
    expect(() =>
      validateConfig(
        testConfig({ distribution: { publicBaseURL: "https://example.test", localPort: 0 } }),
      ),
    ).toThrow("valid TCP port");
    expect(() => validateConfig({ ...testConfig(), surprise: true })).toThrow("unknown fields");
  });

  test("finds and loads a TypeScript config above a nested caller directory", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios core config "));
    const nested = resolve(root, "a folder/deep");
    await mkdir(nested, { recursive: true });
    await writeFile(
      resolve(root, "ios-core.config.ts"),
      `export default ${JSON.stringify(testConfig())};\n`,
    );
    try {
      expect(await findConfigPath(nested)).toBe(resolve(root, "ios-core.config.ts"));
      const loaded = await loadConfig(nested);
      expect(loaded.root).toBe(root);
      expect(loaded.config.app.id).toBe("field-guide");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a missing path-based verification hook while loading", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ios-core-missing-hook-"));
    await writeFile(
      resolve(root, "ios-core.config.ts"),
      `export default ${JSON.stringify(
        testConfig({ verification: { command: ["./scripts/missing.sh", "{appPath}"] } }),
      )};\n`,
    );
    try {
      await expect(loadConfig(root)).rejects.toThrow("Verification hook does not exist");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves release storage relative to the config and honors execution overrides", () => {
    const config = testConfig({
      distribution: {
        publicBaseURL: "https://default.example.test",
        localPort: 38_447,
        releasesRoot: "artifacts/releases",
      },
    });
    expect(resolveDistribution(config, "/tmp/a project").releasesRoot).toBe(
      "/tmp/a project/artifacts/releases",
    );
    process.env.IOS_CORE_RELEASES_ROOT = "/tmp/override";
    process.env.IOS_CORE_PUBLIC_BASE_URL = "https://override.example.test/";
    process.env.IOS_CORE_LOCAL_PORT = "39000";
    expect(resolveDistribution(config, "/tmp/a project")).toEqual({
      releasesRoot: "/tmp/override",
      publicBaseURL: "https://override.example.test",
      localPort: 39_000,
    });
  });
});
