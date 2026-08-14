import type { CommandRunner } from "./process";

export async function parsePlist<T>(contents: string, runner: CommandRunner): Promise<T> {
  const json = await runner.capture(["plutil", "-convert", "json", "-o", "-", "-"], {
    input: contents,
  });
  return JSON.parse(json) as T;
}

export async function readPlist<T>(path: string, runner: CommandRunner): Promise<T> {
  const json = await runner.capture(["plutil", "-convert", "json", "-o", "-", path]);
  return JSON.parse(json) as T;
}

export async function extractPlistRaw(
  contents: string,
  key: string,
  runner: CommandRunner,
): Promise<string> {
  return runner.capture(["plutil", "-extract", key, "raw", "-o", "-", "-"], {
    input: contents,
  });
}

export async function extractPlistJSON<T>(
  contents: string,
  key: string,
  runner: CommandRunner,
): Promise<T> {
  const json = await runner.capture(["plutil", "-extract", key, "json", "-o", "-", "-"], {
    input: contents,
  });
  return JSON.parse(json) as T;
}

export async function extractOptionalPlistRaw(
  contents: string,
  key: string,
  runner: CommandRunner,
): Promise<string | undefined> {
  try {
    return await extractPlistRaw(contents, key, runner);
  } catch {
    return undefined;
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderExportOptions(options: {
  bundleIdentifier: string;
  profileName: string;
  signingIdentity: string;
  teamIdentifier: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key><string>export</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>method</key><string>release-testing</string>
  <key>signingCertificate</key><string>${xmlEscape(options.signingIdentity)}</string>
  <key>signingStyle</key><string>manual</string>
  <key>stripSwiftSymbols</key><true/>
  <key>teamID</key><string>${xmlEscape(options.teamIdentifier)}</string>
  <key>thinning</key><string>&lt;none&gt;</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${xmlEscape(options.bundleIdentifier)}</key><string>${xmlEscape(options.profileName)}</string>
  </dict>
</dict>
</plist>
`;
}
