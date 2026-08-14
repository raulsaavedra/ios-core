import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertArtifactMatchesReceipt, readReleaseReceipt } from "./receipts";
import type { RegisteredApplication, ReleaseReceipt } from "./types";

interface ByteRange {
  start: number;
  end: number;
}

class ReleaseNotFoundError extends Error {}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function xmlEscape(value: string): string {
  return htmlEscape(value).replaceAll("'", "&apos;");
}

function versionedURL(baseURL: URL, pathname: string): URL {
  const url = new URL(baseURL);
  const basePath = baseURL.pathname === "/" ? "" : baseURL.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}${pathname}`;
  return url;
}

export function renderInstaller(
  application: RegisteredApplication,
  receipt: ReleaseReceipt,
): string {
  const manifestURL = versionedURL(
    new URL(application.publicBaseURL),
    `/releases/${receipt.build}/manifest.plist`,
  ).toString();
  const installURL = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestURL)}`;
  const description = application.installerDescription
    ? `<p>${htmlEscape(application.installerDescription)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Install ${htmlEscape(application.displayName)}</title>
  <style>
    :root { color-scheme: light; font-family: ui-rounded, "SF Pro Rounded", sans-serif; background: #eef1ed; color: #183028; }
    body { min-height: 100svh; display: grid; place-items: center; margin: 0; padding: 24px; box-sizing: border-box; background: radial-gradient(circle at top, #dbe5dc, #eef1ed 60%); }
    main { width: min(100%, 420px); padding: 36px 28px; box-sizing: border-box; border: 1px solid #b8c5bc; border-radius: 28px; background: rgba(255, 255, 255, .78); box-shadow: 0 24px 60px rgba(24, 48, 40, .14); text-align: center; }
    h1 { margin: 0 0 10px; font-family: Georgia, serif; font-size: 34px; line-height: 1.05; }
    p { margin: 0 0 28px; color: #52655d; line-height: 1.5; }
    a { display: block; padding: 16px 20px; border-radius: 16px; background: #183028; color: #fff; font-weight: 700; text-decoration: none; }
    small { display: block; margin-top: 18px; color: #6e7d76; }
  </style>
</head>
<body>
  <main>
    <h1>${htmlEscape(application.displayName)}</h1>
    ${description}
    <a href="${htmlEscape(installURL)}">Install version ${htmlEscape(receipt.version)}, build ${receipt.build}</a>
    <small>Keep Tailscale connected until installation completes.</small>
  </main>
</body>
</html>
`;
}

export function renderManifest(
  application: RegisteredApplication,
  receipt: ReleaseReceipt,
): string {
  const ipaURL = versionedURL(
    new URL(application.publicBaseURL),
    `/releases/${receipt.build}/${receipt.ipaRelativePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  ).toString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array><dict><key>kind</key><string>software-package</string><key>url</key><string>${xmlEscape(ipaURL)}</string></dict></array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${xmlEscape(receipt.bundleIdentifier)}</string>
        <key>bundle-version</key><string>${receipt.build}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${xmlEscape(application.displayName)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

export function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0 || size <= 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function textResponse(body: string, contentType: string, method: string): Response {
  return new Response(method === "HEAD" ? null : body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(Buffer.byteLength(body)),
      "Content-Type": contentType,
    },
  });
}

async function readCurrentReceipt(application: RegisteredApplication): Promise<ReleaseReceipt> {
  const currentPath = resolve(application.releasesRoot, "current.json");
  let current: unknown;
  try {
    current = JSON.parse(await readFile(currentPath, "utf8"));
  } catch {
    throw new Error("Current release is unavailable.");
  }
  if (
    typeof current !== "object" ||
    current === null ||
    !Number.isSafeInteger((current as { build?: unknown }).build) ||
    ((current as { build: number }).build ?? 0) <= 0
  ) {
    throw new Error("Current release pointer is invalid.");
  }
  try {
    return await readReleaseReceipt(application.releasesRoot, (current as { build: number }).build);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Current release does not exist.");
    }
    throw error;
  }
}

async function ipaResponse(
  request: Request,
  application: RegisteredApplication,
  receipt: ReleaseReceipt,
): Promise<Response> {
  let path: string;
  try {
    path = await assertArtifactMatchesReceipt(application.releasesRoot, receipt);
  } catch {
    return new Response("Release artifact unavailable", { status: 500 });
  }
  const file = Bun.file(path);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Content-Type": "application/octet-stream",
  });
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader !== null) {
    const range = parseRange(rangeHeader, file.size);
    if (!range) {
      headers.set("Content-Range", `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Length", String(range.end - range.start + 1));
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
    return new Response(request.method === "HEAD" ? null : file.slice(range.start, range.end + 1), {
      status: 206,
      headers,
    });
  }
  headers.set("Content-Length", String(file.size));
  return new Response(request.method === "HEAD" ? null : file, { headers });
}

function safePathname(url: URL): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\\") || pathname.includes("\0")) return null;
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return pathname;
}

export function createOTAHandler(
  application: RegisteredApplication,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const pathname = safePathname(new URL(request.url));
    if (pathname === null) return new Response("Not found", { status: 404 });
    try {
      if (pathname === "/healthz") {
        return textResponse(
          `${JSON.stringify({
            ok: true,
            appId: application.id,
            bundleIdentifier: application.bundleIdentifier,
          })}\n`,
          "application/json; charset=utf-8",
          request.method,
        );
      }
      if (pathname === "/") {
        const receipt = await readCurrentReceipt(application);
        return textResponse(
          renderInstaller(application, receipt),
          "text/html; charset=utf-8",
          request.method,
        );
      }
      if (pathname === "/release.json") {
        const receipt = await readCurrentReceipt(application);
        return textResponse(
          `${JSON.stringify(receipt, null, 2)}\n`,
          "application/json; charset=utf-8",
          request.method,
        );
      }
      const match = /^\/releases\/([1-9]\d*)\/(.+)$/.exec(pathname);
      if (!match) return new Response("Not found", { status: 404 });
      const build = Number(match[1]);
      if (!Number.isSafeInteger(build)) return new Response("Not found", { status: 404 });
      let receipt: ReleaseReceipt;
      try {
        receipt = await readReleaseReceipt(application.releasesRoot, build);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReleaseNotFoundError();
        throw error;
      }
      if (receipt.bundleIdentifier !== application.bundleIdentifier) {
        throw new Error("Release bundle identifier does not match the application registry.");
      }
      const resource = match[2];
      if (resource === "release.json") {
        return textResponse(
          `${JSON.stringify(receipt, null, 2)}\n`,
          "application/json; charset=utf-8",
          request.method,
        );
      }
      if (resource === "manifest.plist") {
        return textResponse(
          renderManifest(application, receipt),
          "application/xml; charset=utf-8",
          request.method,
        );
      }
      if (resource === receipt.ipaRelativePath) {
        return ipaResponse(request, application, receipt);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof ReleaseNotFoundError) return new Response("Not found", { status: 404 });
      return new Response("Release unavailable", { status: 503 });
    }
  };
}

export function startApplicationServer(
  application: RegisteredApplication,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: application.localPort,
    fetch: createOTAHandler(application),
  });
}
