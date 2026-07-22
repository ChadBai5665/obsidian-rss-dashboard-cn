import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import process from "node:process";
import {
  SecretStoreCorruptError,
  SecretStoreSecurityError,
  type SecretFileV1,
  type SecretStatusProjection,
  projectSecretStatus,
} from "./secret-types";
import { resolveDesktopSecretPath } from "./secret-path";

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
}

export interface DesktopSecretFileSystem {
  lstat(path: string): Promise<PathStats>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    content: string,
    options: { encoding: "utf8"; mode: number; flag: "wx" },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  fsyncFile(path: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    assertConnectionId(connectionId);
    return (await this.readSecretFile()).secrets[connectionId]?.apiKey;
  }

  async has(connectionId: string): Promise<boolean> {
    return (await this.get(connectionId)) !== undefined;
  }

  async getStatus(connectionId: string): Promise<SecretStatusProjection> {
    return projectSecretStatus(await this.has(connectionId));
  }

  async set(connectionId: string, apiKey: string): Promise<void> {
    assertConnectionId(connectionId);
    if (!apiKey.trim()) {
      throw new Error("External secret API key must not be blank.");
    }

    await this.update((file) => {
      file.secrets[connectionId] = { apiKey, updatedAt: this.now().toISOString() };
    });
  }

  async delete(connectionId: string): Promise<void> {
    assertConnectionId(connectionId);
    await this.update((file) => {
      delete file.secrets[connectionId];
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
    await this.assertSecretPathSafe();
    try {
      const raw = await this.fileSystem.readFile(this.secretPath, "utf8");
      return parseSecretFile(raw);
    } catch (error) {
      if (isMissingFile(error)) return EMPTY_SECRET_FILE();
      if (error instanceof SecretStoreCorruptError || error instanceof SecretStoreSecurityError) {
        throw error;
      }
      throw error;
    }
  }

  private async writeSecretFile(file: SecretFileV1): Promise<void> {
    await this.ensureSecureDirectory();
    await this.assertSecretPathSafe();
    const tempPath = `${this.secretPath}.tmp-${this.randomSuffix()}`;
    await this.assertPathMissing(tempPath);
    const serialized = `${JSON.stringify(file, null, 2)}\n`;

    await this.assertSecureDirectory();
    await this.fileSystem.writeFile(tempPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    if (this.isUnix()) await this.fileSystem.chmod(tempPath, 0o600);
    await this.fileSystem.fsyncFile(tempPath);
    await this.assertSecureDirectory();
    await this.fileSystem.rename(tempPath, this.secretPath);
    if (this.isUnix()) {
      await this.fileSystem.chmod(this.secretPath, 0o600);
      await this.fileSystem.chmod(this.secretDirectory, 0o700);
      await this.fileSystem.fsyncDirectory(this.secretDirectory);
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

  private isUnix(): boolean {
    return this.platform !== "win32";
  }
}

const NODE_FILE_SYSTEM: DesktopSecretFileSystem = {
  lstat,
  mkdir,
  readFile: async (path, encoding) => readFile(path, encoding),
  writeFile: async (path, content, options) => writeFile(path, content, options),
  rename,
  chmod,
  fsyncFile: async (path) => {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  fsyncDirectory: async (path) => {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

function parseSecretFile(raw: string): SecretFileV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretStoreCorruptError();
  }
  if (!isSecretFileV1(parsed)) throw new SecretStoreCorruptError();
  return parsed;
}

function isSecretFileV1(value: unknown): value is SecretFileV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.secrets)) return false;
  return Object.entries(value.secrets).every(([connectionId, secret]) =>
    UUID_PATTERN.test(connectionId) &&
    isRecord(secret) &&
    typeof secret.apiKey === "string" &&
    secret.apiKey.length > 0 &&
    typeof secret.updatedAt === "string" &&
    Number.isFinite(Date.parse(secret.updatedAt)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertConnectionId(connectionId: string): void {
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error("External secret connection ID must be a UUID.");
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function defaultRandomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
