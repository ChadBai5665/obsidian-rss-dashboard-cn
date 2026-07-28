import { normalizeConnectionId } from "../../security/connection-id";
import type { TikHubSettings } from "../../types/types";
import { normalizeXHandle } from "../source-config";
import {
  TikHubClientError,
  type TikHubUserRequest,
} from "./tikhub-client";
import type { TikHubResult } from "./tikhub-types";
import {
  diagnoseXProfileShape,
  type XProfileShapeDiagnostic,
} from "./x-profile-shape-diagnostic";
import {
  parseXProfile,
  type XProfile,
  XProfileParseError,
} from "./x-profile";

export type XProfileResolverErrorCode =
  | "tikhub-disabled"
  | "missing-key"
  | "invalid-key"
  | "insufficient-balance"
  | "rate-limited"
  | "not-found"
  | "network-timeout"
  | "network-failure"
  | "malformed-response"
  | "profile-shape-unsupported"
  | "provider-failure";

export class XProfileResolverError extends Error {
  readonly diagnostic?: XProfileShapeDiagnostic;

  constructor(
    readonly code: XProfileResolverErrorCode,
    diagnostic?: XProfileShapeDiagnostic,
  ) {
    super(code);
    this.name = "XProfileResolverError";
    if (diagnostic) this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export interface XProfileTikHubClient {
  fetchUserProfile(input: TikHubUserRequest): Promise<TikHubResult<unknown>>;
}

export interface XProfileSecretStore {
  get(connectionId: string): Promise<string | undefined>;
}

export interface XProfileResolverOptions {
  settings: TikHubSettings;
  client: XProfileTikHubClient;
  secretStore: XProfileSecretStore;
  now?: () => Date;
  verificationTtlMs?: number;
}

const PROOF_AUTHORITY = Symbol("x-profile-verification-authority");
const DEFAULT_VERIFICATION_TTL_MS = 5 * 60 * 1_000;
const MAX_VERIFICATION_TTL_MS = 10 * 60 * 1_000;

interface VerificationRecord {
  handle: string;
  restId: string;
  expiresAt: number;
  state: "available" | "reserved" | "consumed";
}

const verificationRecords = new WeakMap<XProfileVerificationProof, VerificationRecord>();
const reservationRecords = new WeakMap<
  XProfileVerificationReservation,
  VerificationRecord
>();

/** Opaque, process-local capability. Its constructor cannot mint a usable proof. */
export class XProfileVerificationProof {
  constructor(authority: typeof PROOF_AUTHORITY) {
    if (authority !== PROOF_AUTHORITY) throw new Error("Invalid X verification proof");
    Object.freeze(this);
  }
}

function mintXProfileVerificationProof(
  record: Omit<VerificationRecord, "state">,
): XProfileVerificationProof {
  const proof = new XProfileVerificationProof(PROOF_AUTHORITY);
  verificationRecords.set(proof, { ...record, state: "available" });
  return proof;
}

/** Opaque transaction handle for one in-progress durable settings write. */
export class XProfileVerificationReservation {
  constructor(authority: typeof PROOF_AUTHORITY) {
    if (authority !== PROOF_AUTHORITY) {
      throw new Error("Invalid X verification reservation");
    }
    Object.freeze(this);
  }
}

export interface VerifiedXProfile {
  profile: Readonly<XProfile>;
  proof: XProfileVerificationProof;
}

/** Reserves an eligible proof so concurrent consumers fail closed. */
export function reserveXProfileVerificationProof(
  profile: XProfile,
  proof: unknown,
  now: Date,
): XProfileVerificationReservation | undefined {
  if (!(proof instanceof XProfileVerificationProof)) return undefined;
  const record = verificationRecords.get(proof);
  const handle = normalizeXHandle(profile.handle);
  const nowMs = now.getTime();
  if (
    !record ||
    record.state !== "available" ||
    !Number.isFinite(nowMs) ||
    nowMs >= record.expiresAt ||
    handle !== record.handle ||
    profile.restId !== record.restId
  ) {
    return undefined;
  }
  record.state = "reserved";
  const reservation = new XProfileVerificationReservation(PROOF_AUTHORITY);
  reservationRecords.set(reservation, record);
  return reservation;
}

/** Irreversibly consumes a reserved proof after the settings write commits. */
export function commitXProfileVerificationReservation(
  reservation: XProfileVerificationReservation,
): void {
  const record = reservationRecords.get(reservation);
  if (!record || record.state !== "reserved") {
    throw new Error("Invalid X verification reservation");
  }
  record.state = "consumed";
  reservationRecords.delete(reservation);
}

/** Releases a failed write only while the original proof remains unexpired. */
export function releaseXProfileVerificationReservation(
  reservation: XProfileVerificationReservation,
  now: Date,
): void {
  const record = reservationRecords.get(reservation);
  if (!record || record.state !== "reserved") return;
  const nowMs = now.getTime();
  record.state = Number.isFinite(nowMs) && nowMs < record.expiresAt
    ? "available"
    : "consumed";
  reservationRecords.delete(reservation);
}

export class XProfileResolver {
  private readonly settings: TikHubSettings;
  private readonly client: XProfileTikHubClient;
  private readonly secretStore: XProfileSecretStore;
  private readonly now: () => Date;
  private readonly verificationTtlMs: number;

  constructor(options: XProfileResolverOptions) {
    this.settings = options.settings;
    this.client = options.client;
    this.secretStore = options.secretStore;
    this.now = options.now ?? (() => new Date());
    this.verificationTtlMs = validVerificationTtl(options.verificationTtlMs);
  }

  async resolve(handle: string, signal?: AbortSignal): Promise<VerifiedXProfile> {
    if (!this.settings.enabled) throw resolverError("tikhub-disabled");
    const normalizedHandle = normalizeXHandle(handle);
    if (!normalizedHandle) throw resolverError("provider-failure");
    const connectionId = normalizeConnectionId(this.settings.connectionId);
    if (!connectionId) throw resolverError("missing-key");

    let secretValue: unknown;
    let apiKey: string | undefined;
    let payload: unknown;
    let profile: XProfile | undefined;
    try {
      try {
        secretValue = await this.secretStore.get(connectionId);
      } catch {
        throw resolverError("provider-failure");
      }
      if (
        secretValue === undefined ||
        (typeof secretValue === "string" && !secretValue.trim())
      ) {
        throw resolverError("missing-key");
      }
      if (typeof secretValue !== "string") throw resolverError("invalid-key");
      apiKey = secretValue;
      if (!isLocallyValidApiKey(apiKey)) throw resolverError("invalid-key");

      try {
        payload = (await this.client.fetchUserProfile({
          apiKey,
          handle: normalizedHandle,
          signal,
        })).data;
      } catch (error) {
        if (error instanceof XProfileResolverError) throw error;
        throw mapClientError(error);
      }

      try {
        profile = parseXProfile(payload);
      } catch (error) {
        if (error instanceof XProfileParseError && error.code === "not-found") {
          throw resolverError("not-found");
        }
        throw resolverError(
          "profile-shape-unsupported",
          diagnoseXProfileShape(payload),
        );
      }
      if (profile.handle !== normalizedHandle) throw resolverError("not-found");
      const verifiedAt = this.now().getTime();
      if (!Number.isFinite(verifiedAt)) throw resolverError("provider-failure");
      const safeProfile = Object.freeze({
        ...profile,
      });
      return {
        profile: safeProfile,
        proof: mintXProfileVerificationProof({
          handle: normalizedHandle,
          restId: safeProfile.restId,
          expiresAt: verifiedAt + this.verificationTtlMs,
        }),
      };
    } finally {
      secretValue = undefined;
      apiKey = undefined;
      payload = undefined;
      profile = undefined;
    }
  }
}

function validVerificationTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_VERIFICATION_TTL_MS;
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_VERIFICATION_TTL_MS
  ) {
    throw new Error("Invalid X verification TTL");
  }
  return value;
}

function mapClientError(error: unknown): XProfileResolverError {
  if (!(error instanceof TikHubClientError)) return resolverError("provider-failure");
  switch (error.code) {
    case "missing-key":
      return resolverError("missing-key");
    case "invalid-key":
      return resolverError("invalid-key");
    case "insufficient-balance":
      return resolverError("insufficient-balance");
    case "rate-limited":
      return resolverError("rate-limited");
    case "timeout":
      return resolverError("network-timeout");
    case "network-failure":
      return resolverError("network-failure");
    case "malformed-response":
      return resolverError("malformed-response");
    case "provider-rejected":
      return error.status === 404
        ? resolverError("not-found")
        : resolverError("provider-failure");
    default:
      return resolverError("provider-failure");
  }
}

function isLocallyValidApiKey(value: string): boolean {
  if (value.length > 4_096 || value.trim() !== value) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

function resolverError(
  code: XProfileResolverErrorCode,
  diagnostic?: XProfileShapeDiagnostic,
): XProfileResolverError {
  return new XProfileResolverError(code, diagnostic);
}
