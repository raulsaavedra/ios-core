# ios-core

Shared Expo development, local iOS builds, artifact verification, and Tailnet installer publication for Raul's personal apps.

```ts
import { defineConfig } from "@raulsaavedra/ios-core";

export default defineConfig({
  schemaVersion: 2,
  app: {
    id: "example",
    displayName: "Example",
    bundleIdentifier: "com.raulsaavedra.example",
  },
  expo: { projectRoot: "apps/mobile", packageManager: "bun" },
  sourceChecks: [["bun", "test"]],
  signing: { teamIdentifier: "5XUYZHSMGZ" },
  distribution: {
    publicBaseURL: "https://mac.example.ts.net:8448",
    localPort: 38449,
  },
});
```

Set `IOS_CORE_DEVICE_UDIDS` in the environment or
`~/.config/ios-core/release.env`, then run:

```bash
ios-core dev
ios-core archive
ios-core release
```

`ios-core dev` uses Expo's native fingerprint to rebuild the local development client only when native inputs change. Set `IOS_CORE_DEV_DEVICE` or pass `--device` for that rebuild; the command never opens Simulator implicitly. TypeScript and React Native changes continue through Metro Fast Refresh. `ios-core prebuild` regenerates the disposable iOS project with Expo CNG, and `ios-core verify` rechecks an archive without publishing it.

Releases register the app in one persistent installer catalog managed by
`com.raulsaavedra.ios-core`. Every app on the machine uses the same distribution endpoint.
