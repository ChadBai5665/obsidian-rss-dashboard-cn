import { normalizeConnectionId } from "../../security/connection-id";
import type { TikHubSettings } from "../../types/types";
import { normalizeXHandle } from "../source-config";
import {
  TikHubClientError,
  type TikHubUserRequest,
} from "./tikhub-client";
import type { TikHubResult } from "./tikhub-types";
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
  | "provider-failure";

export class XProfileResolverError extends Error {
  constructor(readonly code: XProfileResolverErrorCode) {
    super(code);
    this.name = "XProfileResolverError";
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
}

export class XProfileResolver {
  private readonly settings: TikHubSettings;
  private readonly client: XProfileTikHubClient;
  private readonly secretStore: XProfileSecretStore;

  constructor(options: XProfileResolverOptions) {
    this.settings = options.settings;
    this.client = options.client;
    this.secretStore = options.secretStore;
  }

  async resolve(handle: string, signal?: AbortSignal): Promise<XProfile> {
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
        throw resolverError("provider-failure");
      }
      if (profile.handle !== normalizedHandle) throw resolverError("not-found");
      return profile;
    } finally {
      secretValue = undefined;
      apiKey = undefined;
      payload = undefined;
      profile = undefined;
    }
  }
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

function resolverError(code: XProfileResolverErrorCode): XProfileResolverError {
  return new XProfileResolverError(code);
}
