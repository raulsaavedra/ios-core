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
    publicBaseURL: "https://mac.example.ts.net:8445",
    localPort: 38447,
  },
});
```

Set `IOS_CORE_DEVICE_UDIDS` in the environment or `~/.config/ios-core/release.env`, then run:

```bash
ios-core archive
ios-core release
```

Releases automatically keep the copied multi-app OTA service registered and running through
`com.raulsaavedra.ios-core`.
