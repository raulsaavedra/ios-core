import { describe, expect, test } from "bun:test";
import { buildProcessEnvironment } from "../src/process";

describe("release process environment", () => {
  test("gives Apple system tools precedence without dropping developer tools", () => {
    const environment = buildProcessEnvironment(
      { PATH: "/Users/raul/.local/bin:/opt/homebrew/bin", HOME: "/Users/raul" },
      { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
    );

    expect(environment.PATH).toBe(
      "/usr/bin:/bin:/usr/sbin:/sbin:/Users/raul/.local/bin:/opt/homebrew/bin",
    );
    expect(environment.HOME).toBe("/Users/raul");
    expect(environment.DEVELOPER_DIR).toBe("/Applications/Xcode.app/Contents/Developer");
  });
});
