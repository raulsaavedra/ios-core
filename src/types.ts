export type Command = readonly [executable: string, ...arguments_: string[]];

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export interface IOSCoreConfig {
  schemaVersion: 2;
  app: {
    id: string;
    displayName: string;
    installerDescription?: string;
    bundleIdentifier: string;
  };
  expo: {
    projectRoot: string;
    packageManager?: PackageManager;
  };
  sourceChecks: Command[];
  signing: {
    teamIdentifier: string;
    identity?: string;
  };
  verification?: {
    infoPlist?: Record<string, string | number | boolean>;
    forbiddenBundlePatterns?: string[];
    command?: Command;
  };
  distribution: {
    publicBaseURL: string;
    localPort: number;
    releasesRoot?: string;
  };
}

export interface LoadedConfig {
  config: IOSCoreConfig;
  configPath: string;
  root: string;
}

export interface ResolvedDistribution {
  publicBaseURL: string;
  localPort: number;
  releasesRoot: string;
}

export interface ExpoProjectSettings {
  projectRoot: string;
  iosDirectory: string;
  workspacePath: string;
  scheme: string;
  build: number;
  version: string;
  executableName: string;
  productName: string;
  deploymentTarget: string;
  bundleIdentifier: string;
  nativeFingerprint: string;
}

export interface ReleaseReceipt {
  version: string;
  build: number;
  bundleIdentifier: string;
  ipaRelativePath: string;
  sha256: string;
  size: number;
  profileUUID: string;
  publishedAt: string;
}

export interface RegisteredApplication {
  id: string;
  displayName: string;
  installerDescription?: string;
  bundleIdentifier: string;
  releasesRoot: string;
  publicBaseURL: string;
  localPort: number;
}

export interface ServiceRegistry {
  schemaVersion: 1;
  applications: RegisteredApplication[];
}
