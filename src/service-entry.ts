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
const server = servers[0];
if (!server) throw new Error("The shared installer listener did not start.");
console.log(`Shared iOS installer listening on ${server.url}`);
