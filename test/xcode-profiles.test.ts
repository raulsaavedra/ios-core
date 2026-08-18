import { describe, expect, test } from "bun:test";
import { renderExportOptions } from "../src/plist";
import {
  decodeProvisioningProfile,
  type ProvisioningProfile,
  parseProvisioningProfile,
  parseRequiredDeviceUDIDs,
  selectProvisioningProfile,
} from "../src/profiles";
import { parseApplicationBuildSettings, xcodeContainerArguments } from "../src/xcode";
import { fakeRunner, testConfig } from "./support";

const appSettings = {
  PRODUCT_BUNDLE_IDENTIFIER: "com.raulsaavedra.fieldguide",
  WRAPPER_EXTENSION: "app",
  CURRENT_PROJECT_VERSION: "29",
  MARKETING_VERSION: "2.0.0",
  EXECUTABLE_NAME: "FieldGuide",
  PRODUCT_NAME: "FieldGuide",
  IPHONEOS_DEPLOYMENT_TARGET: "18.0",
};

describe("Xcode metadata", () => {
  test("selects the application target from multi-target JSON", () => {
    expect(
      parseApplicationBuildSettings(
        [
          { target: "Tests", buildSettings: { ...appSettings, WRAPPER_EXTENSION: "xctest" } },
          { target: "FieldGuide", buildSettings: appSettings },
        ],
        "com.raulsaavedra.fieldguide",
      ),
    ).toEqual({
      build: 29,
      version: "2.0.0",
      executableName: "FieldGuide",
      productName: "FieldGuide",
      deploymentTarget: "18.0",
    });
  });

  test("rejects zero or ambiguous application targets", () => {
    expect(() => parseApplicationBuildSettings([], "com.example.app")).toThrow("found 0");
    expect(() =>
      parseApplicationBuildSettings(
        [{ buildSettings: appSettings }, { buildSettings: appSettings }],
        "com.raulsaavedra.fieldguide",
      ),
    ).toThrow("found 2");
  });

  test("builds argv-safe project and workspace arguments", () => {
    expect(xcodeContainerArguments(testConfig(), "/tmp/Personal Projects/app")).toEqual([
      "-project",
      "/tmp/Personal Projects/app/apps/ios/Field Guide.xcodeproj",
    ]);
    expect(
      xcodeContainerArguments(
        testConfig({ xcode: { workspace: "App Workspace.xcworkspace", scheme: "App" } }),
        "/tmp/project",
      ),
    ).toEqual(["-workspace", "/tmp/project/App Workspace.xcworkspace"]);
  });
});

describe("provisioning profiles", () => {
  function profile(overrides: Partial<ProvisioningProfile> = {}): ProvisioningProfile {
    return {
      path: "/tmp/profile.mobileprovision",
      uuid: "PROFILE-1",
      name: "Field Guide Ad Hoc",
      expiration: new Date("2030-01-01T00:00:00Z"),
      teamIdentifier: "5XUYZHSMGZ",
      bundleIdentifier: "com.raulsaavedra.fieldguide",
      provisionedDevices: ["DEVICE-A", "DEVICE-B"],
      ...overrides,
    };
  }

  test("parses only distribution device profiles", () => {
    const parsed = parseProvisioningProfile(
      {
        UUID: "PROFILE-1",
        Name: "Field Guide Ad Hoc",
        ExpirationDate: "2030-01-01T00:00:00Z",
        TeamIdentifier: ["5XUYZHSMGZ"],
        ProvisionedDevices: ["DEVICE-A"],
        Entitlements: {
          "application-identifier": "5XUYZHSMGZ.com.raulsaavedra.fieldguide",
          "get-task-allow": false,
        },
      },
      "/tmp/profile",
    );
    expect(parsed?.bundleIdentifier).toBe("com.raulsaavedra.fieldguide");
    expect(
      parseProvisioningProfile(
        {
          UUID: "DEV",
          Name: "Development",
          ExpirationDate: "2030-01-01T00:00:00Z",
          TeamIdentifier: ["5XUYZHSMGZ"],
          ProvisionedDevices: ["DEVICE-A"],
          Entitlements: {
            "application-identifier": "5XUYZHSMGZ.com.raulsaavedra.fieldguide",
            "get-task-allow": true,
          },
        },
        "/tmp/dev",
      ),
    ).toBeNull();
  });

  test("extracts only release fields from decoded Apple profiles", async () => {
    const values: Record<string, string> = {
      UUID: "PROFILE-1",
      Name: "Field Guide Ad Hoc",
      ExpirationDate: "2030-01-01T00:00:00Z",
      TeamIdentifier: '["5XUYZHSMGZ"]',
      ProvisionedDevices: '["DEVICE-A"]',
      Entitlements:
        '{"application-identifier":"5XUYZHSMGZ.com.raulsaavedra.fieldguide","get-task-allow":false}',
    };
    const runner = fakeRunner({
      capture(command) {
        if (command[1] !== "-extract") throw new Error("Whole-profile conversion is forbidden.");
        return values[command[2] ?? ""] ?? "";
      },
    });

    expect(
      await decodeProvisioningProfile("<plist>certificate data</plist>", "/tmp/profile", runner),
    ).toMatchObject({
      uuid: "PROFILE-1",
      bundleIdentifier: "com.raulsaavedra.fieldguide",
      provisionedDevices: ["DEVICE-A"],
    });
  });

  test("requires exact identity, validity, and every configured device", () => {
    const selected = selectProvisioningProfile(
      [
        profile({ uuid: "OLD", expiration: new Date("2029-01-01T00:00:00Z") }),
        profile({ uuid: "NEW", expiration: new Date("2031-01-01T00:00:00Z") }),
        profile({ uuid: "WILDCARD", bundleIdentifier: "*" }),
        profile({ uuid: "MISSING", provisionedDevices: ["DEVICE-A"] }),
      ],
      {
        bundleIdentifier: "com.raulsaavedra.fieldguide",
        teamIdentifier: "5XUYZHSMGZ",
        requiredDevices: ["DEVICE-A", "DEVICE-B"],
        now: new Date("2028-01-01T00:00:00Z"),
      },
    );
    expect(selected.uuid).toBe("NEW");
  });

  test("fails when no profile covers the release devices", () => {
    expect(() =>
      selectProvisioningProfile([profile({ provisionedDevices: ["DEVICE-A"] })], {
        bundleIdentifier: "com.raulsaavedra.fieldguide",
        teamIdentifier: "5XUYZHSMGZ",
        requiredDevices: ["DEVICE-B"],
      }),
    ).toThrow("contains every required device");
  });

  test("normalizes and requires private device configuration", () => {
    expect(parseRequiredDeviceUDIDs(" A, B,A ")).toEqual(["A", "B"]);
    expect(() => parseRequiredDeviceUDIDs("  ")).toThrow("IOS_CORE_DEVICE_UDIDS");
  });

  test("renders escaped manual release-testing export options", () => {
    const plist = renderExportOptions({
      bundleIdentifier: "com.example.app",
      profileName: "Raul & Devices",
      signingIdentity: "Apple Distribution",
      teamIdentifier: "TEAM",
    });
    expect(plist).toContain("<string>release-testing</string>");
    expect(plist).toContain("Raul &amp; Devices");
    expect(plist).toContain("<key>com.example.app</key>");
  });
});
