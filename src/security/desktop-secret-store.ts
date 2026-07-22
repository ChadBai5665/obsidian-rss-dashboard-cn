import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { constants as fileSystemConstants } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import process from "node:process";
import {
  SecretStoreCorruptError,
  SecretStoreSecurityError,
  type SecretFileV1,
  type SecretRecordV1,
  type SecretStatusProjection,
  projectSecretStatus,
} from "./secret-types";
import { resolveDesktopSecretPath } from "./secret-path";
import {
  normalizeConnectionId,
  requireConnectionId,
} from "./connection-id";

export {
  SecretStoreCorruptError,
  SecretStoreSecurityError,
  type SecretFileV1,
  type SecretStatusProjection,
};

interface PathStats {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
  dev: number;
  ino: number;
  size: number;
}

interface SecretFileHandle {
  stat(): Promise<PathStats>;
  readFile(): Promise<string>;
  writeFile(content: string): Promise<void>;
  truncate(length: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface SecretDirectoryHandle {
  stat(): Promise<PathStats>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface SecureParentDirectory {
  handle: SecretDirectoryHandle;
  dev: number;
  ino: number;
  realPath: string;
}

interface OwnedTemporaryFile {
  path: string;
  handle: SecretFileHandle;
  dev: number;
  ino: number;
  byteLength: number;
}

export interface DesktopSecretFileSystem {
  lstat(path: string): Promise<PathStats>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  realpath(path: string): Promise<string>;
  openFile(path: string, flags: number, mode?: number): Promise<SecretFileHandle>;
  openDirectory(path: string, flags: number): Promise<SecretDirectoryHandle>;
}

export interface DesktopSecretStoreOptions {
  secretPath?: string;
  platform?: string;
  fileSystem?: DesktopSecretFileSystem;
  randomSuffix?: () => string;
  now?: () => Date;
  pathOptions?: Omit<import("./secret-path").DesktopSecretPathOptions, "platform">;
}

const EMPTY_SECRET_FILE = (): SecretFileV1 => ({ schemaVersion: 1, secrets: {} });
const mutationQueues = new Map<string, Promise<void>>();

export class DesktopSecretStore {
  private readonly fileSystem: DesktopSecretFileSystem;
  private readonly secretPath: string;
  private readonly secretDirectory: string;
  private readonly path: typeof posix;
  private readonly platform: string;
  private readonly randomSuffix: () => string;
  private readonly now: () => Date;

  constructor(options: DesktopSecretStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.path = this.platform === "win32" ? win32 : posix;
    this.secretPath = options.secretPath ?? resolveDesktopSecretPath({
      platform: this.platform,
      homeDir: options.pathOptions?.homeDir ?? homedir(),
      env: options.pathOptions?.env ?? process.env,
    });
    this.secretDirectory = this.path.dirname(this.secretPath);
    this.fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM;
    this.randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
    this.now = options.now ?? (() => new Date());
  }

  async get(connectionId: string): Promise<string | undefined> {
    const normalizedId = requireConnectionId(connectionId);
    return (await this.readSecretFile()).secrets[normalizedId]?.apiKey;
  }

  async has(connectionId: string): Promise<boolean> {
    return (await this.get(connectionId)) !== undefined;
  }

  async getStatus(connectionId: string): Promise<SecretStatusProjection> {
    return projectSecretStatus(await this.has(connectionId));
  }

  async set(connectionId: string, apiKey: string): Promise<void> {
    const normalizedId = requireConnectionId(connectionId);
    if (!apiKey.trim()) {
      throw new Error("External secret API key must not be blank.");
    }

    await this.update((file) => {
      file.secrets[normalizedId] = { apiKey, updatedAt: this.now().toISOString() };
    });
  }

  async delete(connectionId: string): Promise<void> {
    const normalizedId = requireConnectionId(connectionId);
    await this.update((file) => {
      delete file.secrets[normalizedId];
    });
  }

  private async update(apply: (file: SecretFileV1) => void): Promise<void> {
    const previous = mutationQueues.get(this.secretPath) ?? Promise.resolve();
    const mutation = previous.then(async () => {
      const file = await this.readSecretFile();
      apply(file);
      await this.writeSecretFile(file);
    });
    const recovered = mutation.catch(() => undefined);
    mutationQueues.set(this.secretPath, recovered);

    try {
      await mutation;
    } finally {
      if (mutationQueues.get(this.secretPath) === recovered) {
        mutationQueues.delete(this.secretPath);
      }
    }
  }

  private async readSecretFile(): Promise<SecretFileV1> {
    let parent: SecureParentDirectory | undefined;
    try {
      parent = await this.openSecureParentDirectory();
      await this.assertSecretPathSafe();
      const handle = await this.fileSystem.openFile(this.secretPath, READ_SECRET_FLAGS);
      let raw: string;
      try {
        const stats = await handle.stat();
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw new SecretStoreSecurityError("The external secret file must be a regular file.");
        }
        raw = await handle.readFile();
        await this.assertSameParentDirectory(parent);
      } finally {
        await handle.close();
      }
      return parseSecretFile(raw);
    } catch (error) {
      if (isMissingFile(error)) return EMPTY_SECRET_FILE();
      throw error;
    } finally {
      if (parent) await parent.handle.close();
    }
  }

  private async writeSecretFile(file: SecretFileV1): Promise<void> {
    await this.ensureSecureDirectory();
    const tempPath = `${this.secretPath}.tmp-${this.randomSuffix()}`;
    let ownedTemporary: OwnedTemporaryFile | undefined;
    let parent: SecureParentDirectory | undefined;
    try {
      parent = await this.openSecureParentDirectory();
      await this.assertSecretPathSafe();
      await this.assertPathMissing(tempPath);
      await this.assertSameParentDirectory(parent);
      const serialized = `${JSON.stringify(file, null, 2)}\n`;
      const temporary = await this.fileSystem.openFile(
        tempPath,
        WRITE_SECRET_FLAGS,
        0o600,
      );
      const temporaryStats = await temporary.stat();
      if (temporaryStats.isSymbolicLink() || !temporaryStats.isFile()) {
        await temporary.close();
        throw new SecretStoreSecurityError("The external secret temporary file must be a regular file.");
      }
      ownedTemporary = {
        path: tempPath,
        handle: temporary,
        dev: temporaryStats.dev,
        ino: temporaryStats.ino,
        byteLength: new TextEncoder().encode(serialized).byteLength,
      };
      await temporary.writeFile(serialized);
      if ((await temporary.stat()).size !== ownedTemporary.byteLength) {
        throw new SecretStoreSecurityError("The external secret temporary file was modified during writing.");
      }
      if (this.isUnix()) await this.fileSystem.chmod(tempPath, 0o600);
      await temporary.sync();
      await this.assertSameParentDirectory(parent);
      await this.fileSystem.rename(tempPath, this.secretPath);
      ownedTemporary = undefined;
      await temporary.close();
      await this.assertSameParentDirectory(parent);
      if (this.isUnix()) {
        await this.fileSystem.chmod(this.secretPath, 0o600);
        await this.fileSystem.chmod(this.secretDirectory, 0o700);
      }
      await this.syncDirectoryIfSupported(parent.handle);
    } finally {
      if (ownedTemporary) await this.clearOwnedTemporaryFile(ownedTemporary);
      if (parent) await closeQuietly(parent.handle);
    }
  }

  private async ensureSecureDirectory(): Promise<void> {
    await this.fileSystem.mkdir(this.secretDirectory, { recursive: true, mode: 0o700 });
    await this.assertSecureDirectory();
    if (this.isUnix()) await this.fileSystem.chmod(this.secretDirectory, 0o700);
  }

  private async assertSecretPathSafe(): Promise<void> {
    await this.assertSecureDirectory();
    try {
      const stats = await this.fileSystem.lstat(this.secretPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new SecretStoreSecurityError("The external secret file must be a regular file.");
      }
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }

  private async assertSecureDirectory(): Promise<void> {
    let candidate = this.secretDirectory;
    const root = this.path.parse(candidate).root;
    while (candidate) {
      try {
        const stats = await this.fileSystem.lstat(candidate);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new SecretStoreSecurityError("The external secret directory must not be a symlink.");
        }
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      if (candidate === root) break;
      const parent = this.path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }

  private async assertPathMissing(path: string): Promise<void> {
    try {
      await this.fileSystem.lstat(path);
      throw new SecretStoreSecurityError("Refusing to reuse an external secret temporary file.");
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }

  private async openSecureParentDirectory(): Promise<SecureParentDirectory> {
    await this.assertSecureDirectory();
    const handle = await this.fileSystem.openDirectory(
      this.secretDirectory,
      READ_DIRECTORY_FLAGS,
    );
    try {
      const stats = await handle.stat();
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new SecretStoreSecurityError("The external secret directory must be a regular directory.");
      }
      const realPath = await this.fileSystem.realpath(this.secretDirectory);
      return { handle, dev: stats.dev, ino: stats.ino, realPath };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async assertSameParentDirectory(parent: SecureParentDirectory): Promise<void> {
    // Node exposes no openat-style API for a FileHandle. Path mutations below
    // therefore re-check this pinned directory identity around every critical
    // path operation; a hostile swap can still cause a failed operation, never
    // a successful write we report as safe. This protects against accidental
    // races and hostile links, not a malicious same-account process capable of
    // repeated namespace swaps between every check (Node has no openat here).
    await this.assertSecureDirectory();
    const stats = await this.fileSystem.lstat(this.secretDirectory);
    const realPath = await this.fileSystem.realpath(this.secretDirectory);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      stats.dev !== parent.dev ||
      stats.ino !== parent.ino ||
      realPath !== parent.realPath
    ) {
      throw new SecretStoreSecurityError("The external secret directory changed during an operation.");
    }
  }

  private async syncDirectoryIfSupported(handle: SecretDirectoryHandle): Promise<void> {
    try {
      await handle.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
  }

  private async clearOwnedTemporaryFile(temporary: OwnedTemporaryFile): Promise<void> {
    // The open handle remains pinned even if the directory is renamed. Clear it
    // before using a path again so a moved temporary file cannot retain a key.
    try {
      await temporary.handle.truncate(0);
      await temporary.handle.sync();
    } catch {
      // The original operation error remains the user-facing failure.
    }
    await closeQuietly(temporary.handle);

    try {
      const current = await this.fileSystem.lstat(temporary.path);
      if (
        !current.isSymbolicLink() &&
        current.isFile() &&
        current.dev === temporary.dev &&
        current.ino === temporary.ino
      ) {
        await this.fileSystem.unlink(temporary.path);
      }
    } catch {
      // Never delete a replacement path or replace the original error.
    }
  }

  private isUnix(): boolean {
    return this.platform !== "win32";
  }
}

const NODE_FILE_SYSTEM: DesktopSecretFileSystem = {
  lstat,
  mkdir,
  rename,
  unlink,
  chmod,
  realpath,
  openFile: async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    return {
      stat: () => handle.stat(),
      readFile: async () => handle.readFile({ encoding: "utf8" }),
      writeFile: async (content) => handle.writeFile(content, { encoding: "utf8" }),
      truncate: (length) => handle.truncate(length),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  openDirectory: async (path, flags) => {
    const handle = await open(path, flags);
    return {
      stat: () => handle.stat(),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
};

const NO_FOLLOW = fileSystemConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fileSystemConstants.O_DIRECTORY ?? 0;
const READ_SECRET_FLAGS = fileSystemConstants.O_RDONLY | NO_FOLLOW;
const WRITE_SECRET_FLAGS =
  fileSystemConstants.O_WRONLY |
  fileSystemConstants.O_CREAT |
  fileSystemConstants.O_EXCL |
  NO_FOLLOW;
const READ_DIRECTORY_FLAGS = fileSystemConstants.O_RDONLY | DIRECTORY | NO_FOLLOW;

function parseSecretFile(raw: string): SecretFileV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretStoreCorruptError();
  }
  return normalizeSecretFile(parsed);
}

function normalizeSecretFile(value: unknown): SecretFileV1 {
  const root = isPlainRecord(value) ? value : undefined;
  if (!root || !hasExactOwnDataKeys(root, ["schemaVersion", "secrets"])) {
    throw new SecretStoreCorruptError();
  }
  const schemaVersion = ownData(root, "schemaVersion");
  const secretValue = ownData(root, "secrets");
  const legacySecrets = isPlainRecord(secretValue) ? secretValue : undefined;
  if (schemaVersion !== 1 || !legacySecrets) {
    throw new SecretStoreCorruptError();
  }

  const secrets: Record<string, SecretRecordV1> = {};
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(legacySecrets);
  } catch {
    throw new SecretStoreCorruptError();
  }
  for (const legacyId of keys) {
    if (typeof legacyId !== "string") throw new SecretStoreCorruptError();
    const canonicalId = normalizeConnectionId(legacyId);
    const candidate = readSecretRecord(ownData(legacySecrets, legacyId));
    if (!canonicalId || !candidate) throw new SecretStoreCorruptError();

    const existing = secrets[canonicalId];
    if (existing) {
      if (
        existing.apiKey !== candidate.apiKey ||
        existing.updatedAt !== candidate.updatedAt
      ) throw new SecretStoreCorruptError();
      continue;
    }
    secrets[canonicalId] = candidate;
  }
  return { schemaVersion: 1, secrets };
}

function readSecretRecord(value: unknown): SecretRecordV1 | undefined {
  const record = isPlainRecord(value) ? value : undefined;
  if (!record || !hasExactOwnDataKeys(record, ["apiKey", "updatedAt"])) {
    return undefined;
  }
  const apiKey = ownData(record, "apiKey");
  const updatedAt = ownData(record, "updatedAt");
  if (
    typeof apiKey !== "string" ||
    apiKey.length === 0 ||
    typeof updatedAt !== "string" ||
    !Number.isFinite(Date.parse(updatedAt))
  ) return undefined;
  return { apiKey, updatedAt };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  // JSON.parse produces Object.prototype records; null-prototype records are
  // also safe because every lookup below is own-property based.
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnDataKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && keys.every((key) => {
      if (typeof key !== "string" || !expected.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(descriptor && "value" in descriptor);
    });
  } catch {
    return false;
  }
}

function ownData(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== "string") return false;
  return ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EISDIR"].includes(error.code);
}

async function closeQuietly(handle: { close(): Promise<void> }): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Cleanup must not replace the original storage error.
  }
}

function defaultRandomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
