import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { extractOptionalPlistRaw, extractPlistJSON, extractPlistRaw } from "./plist";
import type { CommandRunner } from "./process";

export interface ProvisioningProfile {
  path: string;
  uuid: string;
  name: string;
  expiration: Date;
  teamIdentifier: string;
  bundleIdentifier: string;
  provisionedDevices: string[];
}

interface ProfilePlist {
  UUID?: unknown;
  Name?: unknown;
  ExpirationDate?: unknown;
  TeamIdentifier?: unknown;
  ProvisionedDevices?: unknown;
  ProvisionsAllDevices?: unknown;
  Entitlements?: { "application-identifier"?: unknown; "get-task-allow"?: unknown };
}

export async function decodeProvisioningProfile(
  contents: string,
  path: string,
  runner: CommandRunner,
): Promise<ProvisioningProfile | null> {
  const [uuid, name, expiration, teamIdentifier, provisionedDevices, entitlements, allDevices] =
    await Promise.all([
      extractPlistRaw(contents, "UUID", runner),
      extractPlistRaw(contents, "Name", runner),
      extractPlistRaw(contents, "ExpirationDate", runner),
      extractPlistJSON<unknown>(contents, "TeamIdentifier", runner),
      extractPlistJSON<unknown>(contents, "ProvisionedDevices", runner),
      extractPlistJSON<NonNullable<ProfilePlist["Entitlements"]>>(contents, "Entitlements", runner),
      extractOptionalPlistRaw(contents, "ProvisionsAllDevices", runner),
    ]);
  return parseProvisioningProfile(
    {
      UUID: uuid,
      Name: name,
      ExpirationDate: expiration,
      TeamIdentifier: teamIdentifier,
      ProvisionedDevices: provisionedDevices,
      ProvisionsAllDevices: allDevices === "true",
      Entitlements: entitlements,
    },
    path,
  );
}

export function parseRequiredDeviceUDIDs(value = process.env.IOS_CORE_DEVICE_UDIDS): string[] {
  const devices = value
    ?.split(",")
    .map((device) => device.trim())
    .filter(Boolean);
  if (!devices || devices.length === 0) {
    throw new Error("IOS_CORE_DEVICE_UDIDS must contain at least one required device UDID.");
  }
  return [...new Set(devices)];
}

export function parseProvisioningProfile(
  value: ProfilePlist,
  path: string,
): ProvisioningProfile | null {
  const applicationIdentifier = value.Entitlements?.["application-identifier"];
  const team = Array.isArray(value.TeamIdentifier) ? value.TeamIdentifier[0] : undefined;
  const devices = value.ProvisionedDevices;
  if (
    typeof value.UUID !== "string" ||
    typeof value.Name !== "string" ||
    typeof value.ExpirationDate !== "string" ||
    typeof applicationIdentifier !== "string" ||
    typeof team !== "string" ||
    !Array.isArray(devices) ||
    !devices.every((device) => typeof device === "string") ||
    value.ProvisionsAllDevices === true ||
    value.Entitlements?.["get-task-allow"] !== false ||
    !applicationIdentifier.startsWith(`${team}.`)
  ) {
    return null;
  }
  const expiration = new Date(value.ExpirationDate);
  if (Number.isNaN(expiration.getTime())) return null;
  return {
    path,
    uuid: value.UUID,
    name: value.Name,
    expiration,
    teamIdentifier: team,
    bundleIdentifier: applicationIdentifier.slice(team.length + 1),
    provisionedDevices: devices,
  };
}

export function selectProvisioningProfile(
  profiles: ProvisioningProfile[],
  requirements: {
    bundleIdentifier: string;
    teamIdentifier: string;
    requiredDevices: string[];
    now?: Date;
  },
): ProvisioningProfile {
  const now = requirements.now ?? new Date();
  const matches = profiles
    .filter(
      (profile) =>
        profile.bundleIdentifier === requirements.bundleIdentifier &&
        profile.teamIdentifier === requirements.teamIdentifier &&
        profile.expiration > now &&
        requirements.requiredDevices.every((device) => profile.provisionedDevices.includes(device)),
    )
    .sort(
      (left, right) =>
        right.expiration.getTime() - left.expiration.getTime() ||
        left.uuid.localeCompare(right.uuid),
    );
  const selected = matches[0];
  if (!selected) {
    throw new Error(
      `No valid Ad Hoc profile for ${requirements.bundleIdentifier} contains every required device.`,
    );
  }
  return selected;
}

export async function discoverProvisioningProfile(
  requirements: {
    bundleIdentifier: string;
    teamIdentifier: string;
    requiredDevices: string[];
  },
  runner: CommandRunner,
  directories = [
    resolve(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles"),
    resolve(homedir(), "Library/MobileDevice/Provisioning Profiles"),
  ],
): Promise<ProvisioningProfile> {
  const paths: string[] = [];
  for (const directory of directories) {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".mobileprovision")) {
          paths.push(resolve(directory, entry.name));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const profiles: ProvisioningProfile[] = [];
  for (const path of paths.sort()) {
    try {
      const decoded = await runner.capture(["security", "cms", "-D", "-i", path]);
      const profile = await decodeProvisioningProfile(decoded, path, runner);
      if (profile) profiles.push(profile);
    } catch {}
  }
  return selectProvisioningProfile(profiles, requirements);
}

export async function assertSigningIdentity(
  identity: string,
  runner: CommandRunner,
): Promise<void> {
  const output = await runner.capture(["security", "find-identity", "-v", "-p", "codesigning"]);
  if (!output.includes(identity)) {
    throw new Error(`The ${identity} code-signing identity is not installed.`);
  }
}
