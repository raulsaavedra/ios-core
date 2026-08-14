import { readFile } from "node:fs/promises";
import { parseServiceRegistry, startRegisteredApplications } from "./service";

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2 || arguments_[0] !== "--registry") {
  throw new Error("Usage: ios-core-service --registry <path>");
}
const registryPath = arguments_[1];
if (!registryPath) throw new Error("The service registry path is required.");
const registry = parseServiceRegistry(JSON.parse(await readFile(registryPath, "utf8")));
const servers = startRegisteredApplications(registry);
for (const [index, server] of servers.entries()) {
  const application = registry.applications[index];
  if (!application) throw new Error(`Missing application for service listener ${index}.`);
  console.log(`${application.displayName} OTA listening on ${server.url}`);
}
