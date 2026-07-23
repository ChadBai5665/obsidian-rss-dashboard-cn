import { lstat, mkdir, open, realpath } from "node:fs/promises";
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
  createOwnedDirectory(
    controlledPath: string,
    markerName: string,
    markerContents: string,
  ): Promise<ControlledDirectoryCreation>;
}

export interface ControlledDirectoryCreation {
  readonly identity: ControlledPathIdentity;
  readonly markerPath: string;
  readonly markerContents: string;
  readonly markerIdentity: ControlledPathIdentity;
}

export class ControlledPathCleanupIncompleteError extends Error {
  constructor() {
    super("Controlled path cleanup incomplete");
    this.name = "ControlledPathCleanupIncompleteError";
  }
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
  exists?: (
    controlledPath: string,
    sensitive?: boolean,
  ) => Promise<boolean>;
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
      let identity: ControlledPathIdentity;
      try {
        await handle.writeFile(contents, { encoding: "utf8" });
        await handle.sync();
        const stats = await handle.stat();
        if (!stats.isFile() || stats.nlink > 1) {
          throw new Error("Exclusive controlled file is not a unique file");
        }
        identity = this.desktopIdentity(safePath, "file", stats);
      } finally {
        await handle.close();
      }
      return identity;
    }

    const created = await this.app.vault.create(safePath, contents);
    return {
      path: safePath,
      namespaceKey: namespaceKey(safePath),
      kind: "file",
      token: {
        type: "vault",
        value: created,
      } satisfies VaultIdentityToken,
      destructiveSafe: true,
    };
  }

  async createOwnedDirectory(
    controlledPath: string,
    markerName: string,
    markerContents: string,
  ): Promise<ControlledDirectoryCreation> {
    const safePath = assertControlledRelativePath(controlledPath);
    const safeMarkerName = assertControlledRelativePath(markerName);
    if (safeMarkerName.includes("/")) {
      throw new Error("Directory ownership marker must be a file name");
    }
    const markerPath = `${safePath}/${safeMarkerName}`;
    let identity: ControlledPathIdentity;

    if (this.desktopRoot) {
      const before = await this.inspectDesktop(safePath);
      if (before.kind !== "missing") {
        throw new Error("Controlled directory already exists");
      }
      const adapter = this.app.vault.adapter as AdapterWithDesktopPaths;
      const fullPath = adapter.getFullPath?.(safePath);
      if (!fullPath) throw new Error("Desktop path unavailable");
      await mkdir(fullPath);
      const stats = await lstat(fullPath);
      if (!stats.isDirectory()) {
        throw new Error("Controlled directory creation did not create a directory");
      }
      identity = this.desktopIdentity(safePath, "directory", stats);
    } else {
      const before = await this.inspectVirtual(safePath);
      if (before.kind !== "missing") {
        throw new Error("Controlled directory already exists");
      }
      const created = await this.app.vault.createFolder(safePath);
      identity = {
        path: safePath,
        namespaceKey: namespaceKey(safePath),
        kind: "directory",
        token: {
          type: "vault",
          value: created,
        } satisfies VaultIdentityToken,
        destructiveSafe: true,
      };
      const observed = await this.inspectVirtual(safePath);
      if (!this.isSameIdentity(identity, observed)) {
        throw new Error("Controlled directory changed during creation");
      }
    }

    let markerIdentity: ControlledPathIdentity | undefined;
    try {
      markerIdentity = await this.createExclusive(
        markerPath,
        markerContents,
      );
      const observedDirectory = await this.inspect(safePath);
      const observedMarker = await this.inspect(markerPath);
      if (
        !this.isSameIdentity(identity, observedDirectory) ||
        !this.isSameIdentity(markerIdentity, observedMarker)
      ) {
        throw new Error("Controlled directory ownership could not be bound");
      }
      return {
        identity,
        markerPath,
        markerContents,
        markerIdentity,
      };
    } catch (error) {
      try {
        await this.cleanupIncompleteOwnedDirectory(
          safePath,
          identity,
          markerPath,
          markerContents,
          markerIdentity,
        );
      } catch {
        throw new ControlledPathCleanupIncompleteError();
      }
      throw error;
    }
  }

  private async cleanupIncompleteOwnedDirectory(
    directoryPath: string,
    directoryIdentity: ControlledPathIdentity,
    markerPath: string,
    markerContents: string,
    markerIdentity: ControlledPathIdentity | undefined,
  ): Promise<void> {
    const observedMarker = await this.inspect(markerPath);
    if (markerIdentity) {
      if (
        !markerIdentity.destructiveSafe ||
        !this.isSameIdentity(markerIdentity, observedMarker) ||
        (await this.app.vault.adapter.read(markerPath)) !== markerContents
      ) {
        throw new ControlledPathCleanupIncompleteError();
      }
      await this.app.vault.adapter.remove(markerPath);
      if (await this.app.vault.adapter.exists(markerPath)) {
        throw new ControlledPathCleanupIncompleteError();
      }
    } else if (observedMarker.kind !== "missing") {
      throw new ControlledPathCleanupIncompleteError();
    }

    const observedDirectory = await this.inspect(directoryPath);
    if (
      !directoryIdentity.destructiveSafe ||
      !this.isSameIdentity(directoryIdentity, observedDirectory)
    ) {
      throw new ControlledPathCleanupIncompleteError();
    }
    const contents = await this.app.vault.adapter.list(directoryPath);
    if (contents.files.length > 0 || contents.folders.length > 0) {
      throw new ControlledPathCleanupIncompleteError();
    }
    await this.app.vault.adapter.rmdir(directoryPath, false);
    if (await this.app.vault.adapter.exists(directoryPath)) {
      throw new ControlledPathCleanupIncompleteError();
    }
  }

  private async inspectVirtual(
    controlledPath: string,
  ): Promise<ControlledPathIdentity> {
    await this.assertVirtualExactPath(controlledPath);
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

  private async assertVirtualExactPath(
    controlledPath: string,
  ): Promise<void> {
    const adapter = this.app.vault.adapter as AdapterWithDesktopPaths;
    if (typeof adapter.exists !== "function") return;
    const segments = controlledPath.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const currentPath = segments.slice(0, index).join("/");
      const insensitive = await adapter.exists(currentPath);
      const sensitive = await adapter.exists(currentPath, true);
      if (insensitive && !sensitive) {
        throw new Error("Virtual controlled path has a case alias");
      }
    }
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
    return this.desktopIdentity(
      controlledPath,
      targetStats.isDirectory() ? "directory" : "file",
      targetStats,
    );
  }

  private desktopIdentity(
    controlledPath: string,
    kind: "file" | "directory",
    stats: { dev: number | bigint; ino: number | bigint },
  ): ControlledPathIdentity {
    return {
      path: controlledPath,
      namespaceKey: namespaceKey(controlledPath),
      kind,
      token: {
        type: "desktop",
        dev: stats.dev,
        ino: stats.ino,
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
