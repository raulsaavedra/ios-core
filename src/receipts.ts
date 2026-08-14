import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReleaseReceipt } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function parseReleaseReceipt(value: unknown, expectedBuild?: number): ReleaseReceipt {
  if (!isRecord(value)) throw new Error("Release receipt must be an object.");
  const receipt = value as Partial<ReleaseReceipt>;
  if (
    typeof receipt.version !== "string" ||
    receipt.version === "" ||
    !Number.isSafeInteger(receipt.build) ||
    (receipt.build ?? 0) <= 0 ||
    (expectedBuild !== undefined && receipt.build !== expectedBuild) ||
    typeof receipt.bundleIdentifier !== "string" ||
    receipt.bundleIdentifier === "" ||
    typeof receipt.ipaRelativePath !== "string" ||
    !isSafeRelativePath(receipt.ipaRelativePath) ||
    typeof receipt.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(receipt.sha256) ||
    !Number.isSafeInteger(receipt.size) ||
    (receipt.size ?? 0) <= 0 ||
    typeof receipt.profileUUID !== "string" ||
    receipt.profileUUID === "" ||
    typeof receipt.publishedAt !== "string" ||
    Number.isNaN(Date.parse(receipt.publishedAt))
  ) {
    throw new Error(
      expectedBuild === undefined
        ? "Invalid release receipt."
        : `Invalid release receipt for build ${expectedBuild}.`,
    );
  }
  return receipt as ReleaseReceipt;
}

export async function readReleaseReceipt(
  releasesRoot: string,
  build: number,
): Promise<ReleaseReceipt> {
  const path = resolve(releasesRoot, String(build), "release.json");
  return parseReleaseReceipt(JSON.parse(await readFile(path, "utf8")), build);
}

export async function publishedBuilds(releasesRoot: string): Promise<number[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(releasesRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const builds: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
    try {
      await readReleaseReceipt(releasesRoot, Number(entry.name));
      builds.push(Number(entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return builds.sort((left, right) => left - right);
}

export function determineNextBuild(sourceBuild: number, published: number[]): number {
  const highest = published.reduce((current, build) => Math.max(current, build), 0);
  return Math.max(sourceBuild, highest + 1);
}

export function validateExplicitBuild(build: number, published: number[]): void {
  const highest = published.reduce((current, value) => Math.max(current, value), 0);
  if (published.includes(build)) throw new Error(`Build ${build} is already published.`);
  if (build <= highest) {
    throw new Error(`Build ${build} must be greater than published Build ${highest}.`);
  }
}

export async function writeJSONAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, path);
}

export async function writeCurrentRelease(releasesRoot: string, build: number): Promise<void> {
  await mkdir(releasesRoot, { recursive: true });
  await writeJSONAtomic(resolve(releasesRoot, "current.json"), { build });
}

export async function readCurrentContents(releasesRoot: string): Promise<string | undefined> {
  try {
    return await readFile(resolve(releasesRoot, "current.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function assertArtifactMatchesReceipt(
  releasesRoot: string,
  receipt: ReleaseReceipt,
): Promise<string> {
  const path = resolve(releasesRoot, String(receipt.build), receipt.ipaRelativePath);
  const info = await stat(path);
  if (!info.isFile() || info.size !== receipt.size) {
    throw new Error(`Release ${receipt.build} artifact does not match its receipt.`);
  }
  return path;
}

export async function verifyArtifactIntegrity(
  releasesRoot: string,
  receipt: ReleaseReceipt,
): Promise<string> {
  const path = await assertArtifactMatchesReceipt(releasesRoot, receipt);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  const actual = hasher.digest("hex");
  if (actual !== receipt.sha256.toLowerCase()) {
    throw new Error(`Release ${receipt.build} artifact checksum does not match its receipt.`);
  }
  return path;
}
