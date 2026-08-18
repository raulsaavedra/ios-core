export type Command = readonly [executable: string, ...arguments_: string[]];

export type XcodeContainer =
  | { project: string; workspace?: never }
  | { workspace: string; project?: never };

export interface IOSCoreConfig {
  schemaVersion: 1;
  app: {
    id: string;
    displayName: string;
    installerDescription?: string;
    bundleIdentifier: string;
  };
  xcode: XcodeContainer & {
    scheme: string;
    configuration?: string;
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
