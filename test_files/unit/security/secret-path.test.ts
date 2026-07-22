import { describe, expect, it } from "vitest";
import { resolveDesktopSecretPath } from "../../../src/security/secret-path";

describe("resolveDesktopSecretPath", () => {
  it("uses the macOS application-support directory", () => {
    expect(
      resolveDesktopSecretPath({
        platform: "darwin",
        homeDir: "/Users/alice",
        env: {},
      }),
    ).toBe("/Users/alice/Library/Application Support/rss-dashboard-cn/secrets.json");
  });

  it("uses APPDATA on Windows", () => {
    expect(
      resolveDesktopSecretPath({
        platform: "win32",
        homeDir: "C:\\Users\\alice",
        env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
      }),
    ).toBe("C:\\Users\\alice\\AppData\\Roaming\\rss-dashboard-cn\\secrets.json");
  });

  it("uses XDG_CONFIG_HOME on Linux", () => {
    expect(
      resolveDesktopSecretPath({
        platform: "linux",
        homeDir: "/home/alice",
        env: { XDG_CONFIG_HOME: "/home/alice/.local/config" },
      }),
    ).toBe("/home/alice/.local/config/rss-dashboard-cn/secrets.json");
  });

  it("falls back to ~/.config on Linux when XDG_CONFIG_HOME is missing", () => {
    expect(
      resolveDesktopSecretPath({
        platform: "linux",
        homeDir: "/home/alice",
        env: {},
      }),
    ).toBe("/home/alice/.config/rss-dashboard-cn/secrets.json");
  });

  it("does not accept a blank Windows APPDATA override", () => {
    expect(
      resolveDesktopSecretPath({
        platform: "win32",
        homeDir: "C:\\Users\\alice",
        env: { APPDATA: "   " },
      }),
    ).toBe("C:\\Users\\alice\\AppData\\Roaming\\rss-dashboard-cn\\secrets.json");
  });

  it("ignores a relative APPDATA value so secrets cannot land under the working directory", () => {
    expect(
      resolveDesktopSecretPath({
        platform: "win32",
        homeDir: "C:\\Users\\alice",
        env: { APPDATA: "relative-app-data" },
      }),
    ).toBe("C:\\Users\\alice\\AppData\\Roaming\\rss-dashboard-cn\\secrets.json");
  });

  it("ignores a relative XDG_CONFIG_HOME value so secrets cannot land in a vault", () => {
    expect(
      resolveDesktopSecretPath({
        platform: "linux",
        homeDir: "/home/alice",
        env: { XDG_CONFIG_HOME: ".vault-config/plugins" },
      }),
    ).toBe("/home/alice/.config/rss-dashboard-cn/secrets.json");
  });
});
