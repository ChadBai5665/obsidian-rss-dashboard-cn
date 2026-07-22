import { posix, win32 } from "node:path";

export interface DesktopSecretPathOptions {
  platform: string;
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

const APPLICATION_DIRECTORY = "rss-dashboard-cn";
const SECRET_FILENAME = "secrets.json";

/**
 * Computes the desktop-only secret path without reading or writing the host.
 * Keeping this deterministic makes platform paths testable without touching a
 * user's real home directory.
 */
export function resolveDesktopSecretPath(options: DesktopSecretPathOptions): string {
  const path = options.platform === "win32" ? win32 : posix;
  const homeDir = requireNonBlank(options.homeDir, "home directory");

  if (options.platform === "darwin") {
    return path.join(
      homeDir,
      "Library",
      "Application Support",
      APPLICATION_DIRECTORY,
      SECRET_FILENAME,
    );
  }

  if (options.platform === "win32") {
    const appData = absoluteEnvironmentPath(options.env.APPDATA, win32) ?? path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, APPLICATION_DIRECTORY, SECRET_FILENAME);
  }

  const configHome = absoluteEnvironmentPath(options.env.XDG_CONFIG_HOME, posix) ?? path.join(homeDir, ".config");
  return path.join(configHome, APPLICATION_DIRECTORY, SECRET_FILENAME);
}

function nonBlank(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

function absoluteEnvironmentPath(
  value: string | undefined,
  path: Pick<typeof posix, "isAbsolute">,
): string | undefined {
  const candidate = nonBlank(value);
  return candidate && path.isAbsolute(candidate) ? candidate : undefined;
}

function requireNonBlank(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`External secret ${label} is required.`);
  }
  return value;
}
