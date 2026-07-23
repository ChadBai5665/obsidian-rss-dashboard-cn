import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TFile, TFolder, type App } from "obsidian";

export type ControlledPathKind = "missing" | "file" | "directory";

export interface ControlledPathIdentity {
  readonly path: string;
  readonly namespaceKey: string;
  readonly kind: ControlledPathKind;
  readonly token?: unknown;
  readonly destructiveSafe: boolean;
}

export interface PathIdentityProvider {
  inspect(controlledPath: string): Promise<ControlledPathIdentity>;
  assertSafePaths(
    controlledPaths: readonly string[],
  ): Promise<Map<string, ControlledPathIdentity>>;
  isSameIdentity(
    expected: ControlledPathIdentity,
    actual: ControlledPathIdentity,
  ): boolean;
  createExclusive(
    controlledPath: string,
    contents: string,
  ): Promise<ControlledPathIdentity>;
}

const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const INVALID_WINDOWS_CHARACTER = /[:*?"<>|]/u;
const DRIVE_OR_UNC = /^(?:[A-Za-z]:|\\\\|\/\/)/u;

export function assertControlledRelativePath(value: string): string {
  if (
    !value ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    DRIVE_OR_UNC.test(value) ||
    path.posix.isAbsolute(value)
  ) {
    throw new Error("Unsafe controlled path");
  }

  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        hasControlCharacter(segment) ||
        INVALID_WINDOWS_CHARACTER.test(segment) ||
        WINDOWS_RESERVED_NAME.test(segment),
    )
  ) {
    throw new Error("Unsafe controlled path");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
    );
  });
}

function namespaceKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function assertNoNamespaceAliases(paths: readonly string[]): void {
  const prefixes = new Map<string, string>();
  for (const controlledPath of paths) {
    const segments = controlledPath.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      const key = namespaceKey(prefix);
      const previous = prefixes.get(key);
      if (previous !== undefined && previous !== prefix) {
        throw new Error("Controlled paths alias by case or Unicode");
      }
      prefixes.set(key, prefix);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

type AdapterWithDesktopPaths = {
  getBasePath?: () => string;
  getFullPath?: (controlledPath: string) => string;
};

type DesktopIdentityToken = {
  readonly type: "desktop";
  readonly dev: number | bigint;
  readonly ino: number | bigint;
};

type VaultIdentityToken = {
  readonly type: "vault";
  readonly value: TFile | TFolder;
};

export class VaultPathIdentityProvider implements PathIdentityProvider {
  private readonly app: App;
  private readonly desktopRoot: string | undefined;
  private desktopRealRoot: string | undefined;

  constructor(app: App) {
    this.app = app;
    const adapter = app.vault.adapter as AdapterWithDesktopPaths;
    const basePath = adapter.getBasePath?.();
    const probe = adapter.getFullPath?.(".rss-dashboard-path-probe");
    if (
      typeof basePath === "string" &&
      typeof probe === "string" &&
      path.isAbsolute(basePath) &&
      path.isAbsolute(probe)
    ) {
      this.desktopRoot = path.resolve(basePath);
    }
  }

  async inspect(controlledPath: string): Promise<ControlledPathIdentity> {
    const safePath = assertControlledRelativePath(controlledPath);
    if (this.desktopRoot) {
      return this.inspectDesktop(safePath);
    }
    return this.inspectVirtual(safePath);
  }

  async assertSafePaths(
    controlledPaths: readonly string[],
  ): Promise<Map<string, ControlledPathIdentity>> {
    const uniquePaths = [...new Set(controlledPaths)];
    for (const controlledPath of uniquePaths) {
      assertControlledRelativePath(controlledPath);
    }
    assertNoNamespaceAliases(uniquePaths);

    const result = new Map<string, ControlledPathIdentity>();
    const physicalIdentities = new Map<string, string>();
    for (const controlledPath of uniquePaths) {
      const identity = await this.inspect(controlledPath);
      result.set(controlledPath, identity);
      const token = identity.token;
      if (
        token &&
        typeof token === "object" &&
        "type" in token &&
        (token as { type?: unknown }).type === "desktop"
      ) {
        const desktop = token as DesktopIdentityToken;
        const physicalKey = `${desktop.dev}:${desktop.ino}`;
        const previous = physicalIdentities.get(physicalKey);
        if (previous !== undefined && previous !== controlledPath) {
          throw new Error("Controlled paths alias the same filesystem object");
        }
        physicalIdentities.set(physicalKey, controlledPath);
      }
    }
    return result;
  }

  isSameIdentity(
    expected: ControlledPathIdentity,
    actual: ControlledPathIdentity,
  ): boolean {
    if (
      expected.path !== actual.path ||
      expected.kind !== actual.kind ||
      !expected.token ||
      !actual.token
    ) {
      return false;
    }
    const expectedToken = expected.token as
      | DesktopIdentityToken
      | VaultIdentityToken;
    const actualToken = actual.token as
      | DesktopIdentityToken
      | VaultIdentityToken;
    if (expectedToken.type !== actualToken.type) return false;
    if (expectedToken.type === "desktop" && actualToken.type === "desktop") {
      return (
        expectedToken.dev === actualToken.dev &&
        expectedToken.ino === actualToken.ino
      );
    }
    return (
      expectedToken.type === "vault" &&
      actualToken.type === "vault" &&
      expectedToken.value === actualToken.value
    );
  }

  async createExclusive(
    controlledPath: string,
    contents: string,
  ): Promise<ControlledPathIdentity> {
    const safePath = assertControlledRelativePath(controlledPath);
    if (this.desktopRoot) {
      await this.inspectDesktop(safePath);
      const adapter = this.app.vault.adapter as AdapterWithDesktopPaths;
      const fullPath = adapter.getFullPath?.(safePath);
      if (!fullPath) throw new Error("Desktop path unavailable");
      const handle = await open(fullPath, "wx");
      try {
        await handle.writeFile(contents, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await this.app.vault.create(safePath, contents);
    }
    const identity = await this.inspect(safePath);
    if (identity.kind !== "file" || !identity.destructiveSafe) {
      throw new Error("Exclusive controlled file has no safe identity");
    }
    return identity;
  }

  private async inspectVirtual(
    controlledPath: string,
  ): Promise<ControlledPathIdentity> {
    const abstractFile =
      this.app.vault.getAbstractFileByPath(controlledPath);
    if (abstractFile instanceof TFile) {
      return {
        path: controlledPath,
        namespaceKey: namespaceKey(controlledPath),
        kind: "file",
        token: { type: "vault", value: abstractFile } satisfies VaultIdentityToken,
        destructiveSafe: true,
      };
    }
    if (abstractFile instanceof TFolder) {
      return {
        path: controlledPath,
        namespaceKey: namespaceKey(controlledPath),
        kind: "directory",
        token: { type: "vault", value: abstractFile } satisfies VaultIdentityToken,
        destructiveSafe: true,
      };
    }
    if (await this.app.vault.adapter.exists(controlledPath)) {
      return {
        path: controlledPath,
        namespaceKey: namespaceKey(controlledPath),
        kind: "file",
        destructiveSafe: false,
      };
    }
    return {
      path: controlledPath,
      namespaceKey: namespaceKey(controlledPath),
      kind: "missing",
      destructiveSafe: false,
    };
  }

  private async inspectDesktop(
    controlledPath: string,
  ): Promise<ControlledPathIdentity> {
    const root = this.desktopRoot;
    if (!root) throw new Error("Desktop root unavailable");
    const adapter = this.app.vault.adapter as AdapterWithDesktopPaths;
    const fullPath = adapter.getFullPath?.(controlledPath);
    if (!fullPath || !path.isAbsolute(fullPath)) {
      throw new Error("Unsafe desktop adapter path");
    }
    const resolved = path.resolve(fullPath);
    if (!isWithin(root, resolved)) {
      throw new Error("Controlled path escapes the vault");
    }

    const realRoot =
      this.desktopRealRoot ?? (this.desktopRealRoot = await realpath(root));
    const relativeSegments = path.relative(root, resolved).split(path.sep);
    let current = root;
    let lastExisting = root;
    const visitedSegments: string[] = [];
    let targetStats:
      | Awaited<ReturnType<typeof lstat>>
      | undefined;
    for (const segment of relativeSegments) {
      visitedSegments.push(segment);
      current = path.join(current, segment);
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) {
          throw new Error("Symlink below the trusted vault root");
        }
        const realCurrent = await realpath(current);
        const actualSegments = path
          .relative(realRoot, realCurrent)
          .split(path.sep);
        if (
          actualSegments.length !== visitedSegments.length ||
          actualSegments.some(
            (actual, index) => actual !== visitedSegments[index],
          )
        ) {
          throw new Error(
            "Controlled path aliases different case or Unicode spelling",
          );
        }
        lastExisting = current;
        if (current === resolved) targetStats = stats;
      } catch (error) {
        if (isMissingFile(error)) break;
        throw error;
      }
    }
    const realParent = await realpath(lastExisting);
    if (!isWithin(realRoot, realParent)) {
      throw new Error("Controlled path resolves outside the vault");
    }

    if (!targetStats) {
      return {
        path: controlledPath,
        namespaceKey: namespaceKey(controlledPath),
        kind: "missing",
        destructiveSafe: true,
      };
    }
    if (!targetStats.isFile() && !targetStats.isDirectory()) {
      throw new Error("Controlled path is not a regular file or directory");
    }
    if (targetStats.isFile() && targetStats.nlink > 1) {
      throw new Error("Controlled file has a hardlink alias");
    }
    return {
      path: controlledPath,
      namespaceKey: namespaceKey(controlledPath),
      kind: targetStats.isDirectory() ? "directory" : "file",
      token: {
        type: "desktop",
        dev: targetStats.dev,
        ino: targetStats.ino,
      } satisfies DesktopIdentityToken,
      destructiveSafe: true,
    };
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
