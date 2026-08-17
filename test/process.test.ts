import { describe, expect, test } from "bun:test";
import { buildProcessEnvironment } from "../src/process";

describe("release process environment", () => {
  test("gives Apple system tools precedence without dropping developer tools", () => {
    const environment = buildProcessEnvironment(
      { PATH: "/Users/raul/.local/bin:/opt/homebrew/bin", HOME: "/Users/raul" },
      { EXPO_NO_GIT_STATUS: "1" },
    );

    expect(environment.PATH).toBe(
      "/usr/bin:/bin:/usr/sbin:/sbin:/Users/raul/.local/bin:/opt/homebrew/bin",
    );
    expect(environment.HOME).toBe("/Users/raul");
    expect(environment.EXPO_NO_GIT_STATUS).toBe("1");
  });
});
