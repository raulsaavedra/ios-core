import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { systemRunner } from "../src/process";
import { readArchiveProperties } from "../src/verifier";

test("archive verification extracts application metadata without converting plist dates", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ios-core-archive-plist-"));
  const path = resolve(root, "Info.plist");
  try {
    await writeFile(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CreationDate</key><date>2026-08-14T00:00:00Z</date>
  <key>ApplicationProperties</key><dict>
    <key>CFBundleIdentifier</key><string>com.example.app</string>
    <key>CFBundleVersion</key><string>30</string>
    <key>Architectures</key><array><string>arm64</string></array>
  </dict>
</dict></plist>`,
    );
    expect(await readArchiveProperties(path, systemRunner)).toMatchObject({
      CFBundleIdentifier: "com.example.app",
      CFBundleVersion: "30",
      Architectures: ["arm64"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
