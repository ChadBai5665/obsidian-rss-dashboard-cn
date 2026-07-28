import type { XProfileResolverErrorCode } from "../../sources/tikhub/x-profile-resolver.js";
import type { XProfileShapeIssue } from "../../sources/tikhub/x-profile-shape-diagnostic.js";
import type { SourceIdentifierErrorCode } from "./source-identifier.js";

export type VerificationWarningCode =
  | "empty-feed"
  | "feed-selection-required";

export type VerificationFailureCode =
  | SourceIdentifierErrorCode
  | XProfileResolverErrorCode
  | "network-request-failed"
  | "youtube-channel-not-found"
  | "youtube-request-failed"
  | "youtube-feed-invalid"
  | "feed-not-found";

export type VerificationState<T> =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "checking" }>
  | Readonly<{ status: "success"; value: T }>
  | Readonly<{
      status: "warning";
      value: T;
      code: VerificationWarningCode;
      accepted: boolean;
    }>
  | Readonly<{
      status: "failure";
      code: VerificationFailureCode;
      detail?: XProfileShapeIssue;
    }>;

const WARNING_CODES = new Set<VerificationWarningCode>([
  "empty-feed",
  "feed-selection-required",
]);

const FAILURE_CODES = new Set<VerificationFailureCode>([
  "input-empty",
  "input-too-long",
  "input-unsafe",
  "url-invalid",
  "url-not-http",
  "url-credentials",
  "x-unsupported-host",
  "x-not-profile",
  "x-invalid-handle",
  "youtube-unsupported-host",
  "youtube-not-channel",
  "youtube-invalid-handle",
  "tikhub-disabled",
  "missing-key",
  "invalid-key",
  "insufficient-balance",
  "rate-limited",
  "not-found",
  "network-timeout",
  "network-failure",
  "malformed-response",
  "profile-shape-unsupported",
  "provider-failure",
  "network-request-failed",
  "youtube-channel-not-found",
  "youtube-request-failed",
  "youtube-feed-invalid",
  "feed-not-found",
]);

const X_PROFILE_SHAPE_ISSUES = new Set<XProfileShapeIssue>([
  "no-candidate",
  "required-field-invalid",
  "identity-conflict",
  "optional-field-conflict",
  "unsafe-structure",
  "unknown-shape",
]);

/**
 * Keeps async verification completions tied to the input that started them.
 * Call invalidate when a modal is cancelled or closed.
 */
export class VerificationController<T> {
  private generation = 0;
  private state: VerificationState<T> = freezeState({ status: "idle" });

  begin(_input: string): number {
    this.generation += 1;
    this.state = freezeState({ status: "checking" });
    return this.generation;
  }

  succeed(token: number, value: T): boolean {
    return this.complete(token, freezeState({ status: "success", value }));
  }

  warn(token: number, value: T, code: VerificationWarningCode): boolean {
    if (!isWarningCode(code)) return false;
    return this.complete(
      token,
      freezeState({ status: "warning", value, code, accepted: false }),
    );
  }

  fail(
    token: number,
    code: "profile-shape-unsupported",
    detail?: XProfileShapeIssue,
  ): boolean;
  fail(token: number, code: Exclude<VerificationFailureCode, "profile-shape-unsupported">): boolean;
  fail(
    token: number,
    code: VerificationFailureCode,
    detail?: XProfileShapeIssue,
  ): boolean {
    if (!isFailureCode(code)) return false;
    const failure = code === "profile-shape-unsupported" && isXProfileShapeIssue(detail)
      ? { status: "failure" as const, code, detail }
      : { status: "failure" as const, code };
    return this.complete(token, freezeState(failure));
  }

  invalidate(): void {
    this.generation += 1;
    this.state = freezeState({ status: "idle" });
  }

  snapshot(): VerificationState<T> {
    return this.state;
  }

  canSubscribe(): boolean {
    return (
      this.state.status === "success" ||
      (this.state.status === "warning" &&
        this.state.code === "empty-feed" &&
        this.state.accepted)
    );
  }

  acceptWarning(token: number): boolean {
    if (
      token !== this.generation ||
      this.state.status !== "warning" ||
      this.state.code !== "empty-feed" ||
      this.state.accepted
    ) {
      return false;
    }

    this.state = freezeState({ ...this.state, accepted: true });
    return true;
  }

  private complete(token: number, state: VerificationState<T>): boolean {
    if (token !== this.generation || this.state.status !== "checking") {
      return false;
    }

    this.state = state;
    return true;
  }
}

function freezeState<T>(state: VerificationState<T>): VerificationState<T> {
  return Object.freeze(state);
}

function isWarningCode(value: unknown): value is VerificationWarningCode {
  return typeof value === "string" && WARNING_CODES.has(value as VerificationWarningCode);
}

function isFailureCode(value: unknown): value is VerificationFailureCode {
  return typeof value === "string" && FAILURE_CODES.has(value as VerificationFailureCode);
}

export function isXProfileShapeIssue(value: unknown): value is XProfileShapeIssue {
  return typeof value === "string" && X_PROFILE_SHAPE_ISSUES.has(value as XProfileShapeIssue);
}
