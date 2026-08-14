import type { IOSCoreConfig } from "./types";

export function defineConfig<const Config extends IOSCoreConfig>(config: Config): Config {
  return config;
}
