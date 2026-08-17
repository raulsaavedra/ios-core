import type { CommandRunner } from "../src/process";
import type { IOSCoreConfig } from "../src/types";

export function testConfig(overrides: Partial<IOSCoreConfig> = {}): IOSCoreConfig {
  return {
    schemaVersion: 2,
    app: {
      id: "field-guide",
      displayName: "Field Guide",
      installerDescription: "A native field guide.",
      bundleIdentifier: "com.raulsaavedra.fieldguide",
    },
    expo: { projectRoot: "apps/mobile", packageManager: "bun" },
    sourceChecks: [["bun", "test"]],
    signing: { teamIdentifier: "5XUYZHSMGZ", identity: "Apple Distribution" },
    verification: {
      infoPlist: { APIURL: "https://example.test" },
      forbiddenBundlePatterns: ["*.jsbundle"],
    },
    distribution: {
      publicBaseURL: "https://mac.example.test:8445",
      localPort: 38_447,
    },
    ...overrides,
  };
}

export function fakeRunner(
  options: {
    capture?: (command: readonly string[]) => string | Promise<string>;
    run?: (command: readonly string[]) => void | Promise<void>;
    succeeds?: (command: readonly string[]) => boolean;
  } = {},
): CommandRunner {
  return {
    async capture(command) {
      return (await options.capture?.(command)) ?? "";
    },
    async run(command) {
      await options.run?.(command);
    },
    succeeds(command) {
      return options.succeeds?.(command) ?? false;
    },
  };
}
