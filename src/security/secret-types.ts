/** The only persisted schema for external desktop credentials. */
export interface SecretFileV1 {
  schemaVersion: 1;
  secrets: Record<string, SecretRecordV1>;
}

export interface SecretRecordV1 {
  apiKey: string;
  updatedAt: string;
}

/** Safe to persist in plugin settings or show in status UI. */
export interface SecretStatusProjection {
  hasSecret: boolean;
}

export class SecretStoreCorruptError extends Error {
  readonly code = "secret-store-corrupt";

  constructor(message = "The external secret store is corrupt.") {
    super(message);
    this.name = "SecretStoreCorruptError";
  }
}

export class SecretStoreSecurityError extends Error {
  readonly code = "secret-store-security";

  constructor(message = "The external secret store failed a security check.") {
    super(message);
    this.name = "SecretStoreSecurityError";
  }
}

export function projectSecretStatus(hasSecret: boolean): SecretStatusProjection {
  return { hasSecret };
}
