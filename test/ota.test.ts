import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createGlobalOTAHandler, createOTAHandler } from "../src/ota";
import type { RegisteredApplication, ReleaseReceipt } from "../src/types";

describe("OTA handler", () => {
  let root: string;
  let application: RegisteredApplication;

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), "ios-core-ota-"));
    application = {
      id: "field-guide",
      displayName: "Field Guide",
      installerDescription: "A native field guide.",
      bundleIdentifier: "com.raulsaavedra.fieldguide",
      releasesRoot: root,
      publicBaseURL: "https://mac.example.test:8445",
      localPort: 38_447,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeRelease(build: number, ipa: string): Promise<ReleaseReceipt> {
    const receipt: ReleaseReceipt = {
      version: build === 28 ? "1.9.0" : "2.0.0",
      build,
      bundleIdentifier: application.bundleIdentifier,
      ipaRelativePath: "export/Field Guide.ipa",
      sha256: String(build).padStart(64, "a"),
      size: Buffer.byteLength(ipa),
      profileUUID: "PROFILE",
      publishedAt: "2026-08-14T00:00:00.000Z",
    };
    const directory = resolve(root, String(build));
    await mkdir(resolve(directory, "export"), { recursive: true });
    await writeFile(resolve(directory, "release.json"), `${JSON.stringify(receipt)}\n`);
    await writeFile(resolve(directory, receipt.ipaRelativePath), ipa);
    return receipt;
  }

  function request(path: string, init?: RequestInit): Promise<Response> {
    return createOTAHandler(application)(
      new Request(new URL(path, "http://localhost").toString(), init),
    );
  }

  test("renders the current installer and immutable manifest", async () => {
    await writeRelease(29, "0123456789");
    await writeFile(resolve(root, "current.json"), '{"build":29}\n');
    const installer = await request("/");
    const html = await installer.text();
    expect(installer.status).toBe(200);
    expect(html).toContain("Field Guide");
    expect(html).toContain("build 29");
    expect(html).toContain(
      "https%3A%2F%2Fmac.example.test%3A8445%2Fapps%2Ffield-guide%2Freleases%2F29%2Fmanifest.plist",
    );
    const manifest = await (await request("/releases/29/manifest.plist")).text();
    expect(manifest).toContain("com.raulsaavedra.fieldguide");
    expect(manifest).toContain(
      "https://mac.example.test:8445/apps/field-guide/releases/29/export/Field%20Guide.ipa",
    );
  });

  test("serves a shared catalog and app-namespaced release routes", async () => {
    await writeRelease(29, "0123456789");
    await writeFile(resolve(root, "current.json"), '{"build":29}\n');
    const fitnessRoot = await mkdtemp(resolve(tmpdir(), "ios-core-fitness-"));
    const fitness: RegisteredApplication = {
      id: "fitness",
      displayName: "Fitness",
      bundleIdentifier: "com.raulsaavedra.fitness",
      releasesRoot: fitnessRoot,
      publicBaseURL: application.publicBaseURL,
      localPort: application.localPort,
    };
    try {
      const fitnessReceipt: ReleaseReceipt = {
        version: "1.0.0",
        build: 46,
        bundleIdentifier: fitness.bundleIdentifier,
        ipaRelativePath: "export/Fitness.ipa",
        sha256: "f".repeat(64),
        size: 3,
        profileUUID: "PROFILE",
        publishedAt: "2026-08-16T00:00:00.000Z",
      };
      await mkdir(resolve(fitnessRoot, "46/export"), { recursive: true });
      await writeFile(resolve(fitnessRoot, "46/release.json"), JSON.stringify(fitnessReceipt));
      await writeFile(resolve(fitnessRoot, "46/export/Fitness.ipa"), "fit");
      await writeFile(resolve(fitnessRoot, "current.json"), '{"build":46}\n');
      const handler = createGlobalOTAHandler({
        schemaVersion: 1,
        applications: [fitness, application],
      });
      const requestGlobal = (path: string, init?: RequestInit) =>
        handler(new Request(new URL(path, "http://localhost").toString(), init));
      const catalog = await (await requestGlobal("/")).text();
      expect(catalog).toContain("Fitness");
      expect(catalog).toContain("Field Guide");
      expect(catalog.match(/itms-services:\/\//g)).toHaveLength(2);
      expect(await (await requestGlobal("/apps/fitness/release.json")).json()).toMatchObject({
        build: 46,
      });
      expect(
        await (
          await requestGlobal("/apps/field-guide/releases/29/export/Field%20Guide.ipa")
        ).text(),
      ).toBe("0123456789");
      expect(await (await requestGlobal("/healthz")).json()).toEqual({
        ok: true,
        applications: [
          { appId: "fitness", bundleIdentifier: "com.raulsaavedra.fitness" },
          { appId: "field-guide", bundleIdentifier: "com.raulsaavedra.fieldguide" },
        ],
      });
    } finally {
      await rm(fitnessRoot, { recursive: true, force: true });
    }
  });

  test("identifies the package-owned application without release state", async () => {
    const response = await request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      appId: "field-guide",
      bundleIdentifier: "com.raulsaavedra.fieldguide",
    });
    const head = await request("/healthz", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("serves full GET and bodyless HEAD metadata", async () => {
    await writeRelease(29, "0123456789");
    const get = await request("/releases/29/export/Field%20Guide.ipa");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-length")).toBe("10");
    expect(get.headers.get("accept-ranges")).toBe("bytes");
    expect(await get.text()).toBe("0123456789");
    const head = await request("/releases/29/export/Field%20Guide.ipa", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
  });

  test("serves bounded, open-ended, suffix, and oversized suffix ranges", async () => {
    await writeRelease(29, "0123456789");
    const cases: Array<[string, string, string]> = [
      ["bytes=0-0", "0", "bytes 0-0/10"],
      ["bytes=4-", "456789", "bytes 4-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=-99", "0123456789", "bytes 0-9/10"],
      ["bytes=8-99", "89", "bytes 8-9/10"],
    ];
    for (const [range, body, contentRange] of cases) {
      const response = await request("/releases/29/export/Field%20Guide.ipa", {
        headers: { Range: range },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(await response.text()).toBe(body);
    }
  });

  test("rejects invalid and multi-ranges with 416", async () => {
    await writeRelease(29, "0123456789");
    for (const range of ["bytes=-", "bytes=9-2", "bytes=10-", "bytes=0-1,3-4", "wat"]) {
      const response = await request("/releases/29/export/Field%20Guide.ipa", {
        headers: { Range: range },
      });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
    }
  });

  test("keeps old releases immutable after current promotion", async () => {
    await writeRelease(28, "older");
    await writeRelease(29, "newer");
    await writeFile(resolve(root, "current.json"), '{"build":29}\n');
    expect(await (await request("/releases/28/export/Field%20Guide.ipa")).text()).toBe("older");
    await writeFile(resolve(root, "current.json"), '{"build":28}\n');
    expect(await (await request("/releases/29/export/Field%20Guide.ipa")).text()).toBe("newer");
    expect(await (await request("/")).text()).toContain("build 28");
  });

  test("isolates traversal, unknown releases, corrupt current state, and artifact mismatch", async () => {
    const receipt = await writeRelease(29, "0123456789");
    await writeFile(resolve(root, "current.json"), "broken");
    expect((await request("/")).status).toBe(503);
    expect((await request("/releases/999/release.json")).status).toBe(404);
    expect((await request("/releases/29/%2e%2e%2fcurrent.json")).status).toBe(404);
    expect((await request("/releases/29/export%5CField%20Guide.ipa")).status).toBe(404);
    await writeFile(
      resolve(root, "29/release.json"),
      `${JSON.stringify({ ...receipt, size: 99 })}\n`,
    );
    expect((await request("/releases/29/export/Field%20Guide.ipa")).status).toBe(500);
  });

  test("rejects mutation methods", async () => {
    expect((await request("/", { method: "POST" })).status).toBe(405);
  });
});
