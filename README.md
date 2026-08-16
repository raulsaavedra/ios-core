# ios-core

Shared archive, verification, and Tailnet OTA release tooling for Raul's native iOS apps.

```ts
import { defineConfig } from "@raulsaavedra/ios-core";

export default defineConfig({
  schemaVersion: 1,
  app: {
    id: "example",
    displayName: "Example",
    bundleIdentifier: "com.raulsaavedra.example",
  },
  xcode: { project: "apps/ios/Example.xcodeproj", scheme: "Example" },
  sourceChecks: [["bun", "test"]],
  signing: { teamIdentifier: "5XUYZHSMGZ" },
  distribution: {
    publicBaseURL: "https://mac.example.ts.net:8448",
    localPort: 38449,
  },
});
```

Set `IOS_CORE_DEVICE_UDIDS` in the environment or `~/.config/ios-core/release.env`, then run:

```bash
ios-core archive
ios-core release
```

Releases register the app in one persistent installer catalog managed by
`com.raulsaavedra.ios-core`. Every app on the machine uses the same distribution endpoint.
