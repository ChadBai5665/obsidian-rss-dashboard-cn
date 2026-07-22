// These built-ins are captured once so hostile instance overrides are ignored.
// eslint-disable-next-line @typescript-eslint/unbound-method
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const ABORT_SIGNAL_EVENT_TARGET = Reflect.getPrototypeOf(
  AbortSignal.prototype,
) as object;
const ADD_EVENT_LISTENER: unknown = Object.getOwnPropertyDescriptor(
  ABORT_SIGNAL_EVENT_TARGET,
  "addEventListener",
)?.value;
const REMOVE_EVENT_LISTENER: unknown = Object.getOwnPropertyDescriptor(
  ABORT_SIGNAL_EVENT_TARGET,
  "removeEventListener",
)?.value;
const TRUSTED_ABORT_WORK = new WeakMap<AbortSignal, Promise<void>>();

export interface TrustedAbortRaceOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  createAbortError: () => Error;
  createInvalidSignalError: () => Error;
  createTimeoutError?: () => Error;
  mapFailure?: (error: unknown) => Error;
}

/** Returns undefined rather than invoking accessors on a non-AbortSignal value. */
export function readTrustedAbortState(value: unknown): boolean | undefined {
  if (
    !ABORTED_GETTER ||
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return undefined;
  }
  try {
    const aborted: unknown = Reflect.apply(ABORTED_GETTER, value, []);
    return typeof aborted === "boolean" ? aborted : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Waits for non-cancellable work started with this signal to actually settle.
 * The public request may reject on abort before Obsidian's requestUrl finishes.
 */
export async function waitForTrustedAbortWork(
  signal: AbortSignal,
): Promise<void> {
  if (readTrustedAbortState(signal) === undefined) return;
  await TRUSTED_ABORT_WORK.get(signal);
}

/**
 * Locally races a possibly non-cancellable operation with a trusted signal.
 * The operation's handlers stay attached after abort so late rejections are
 * consumed, while the public promise and abort listener settle immediately.
 */
export function raceWithTrustedAbort<T>(
  start: () => unknown,
  options: TrustedAbortRaceOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let listenerAdded = false;
    let timeout: number | undefined;
    const signal = options.signal;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (
        listenerAdded &&
        signal &&
        typeof REMOVE_EVENT_LISTENER === "function"
      ) {
        try {
          Reflect.apply(REMOVE_EVENT_LISTENER, signal, ["abort", onAbort]);
        } catch {
          // Cleanup failure must never keep the public promise pending.
        }
      }
      action();
    };
    const rejectWith = (error: Error): void => finish(() => reject(error));
    const onAbort = (): void => rejectWith(options.createAbortError());

    if (signal) {
      const initialState = readTrustedAbortState(signal);
      if (
        initialState === undefined ||
        typeof ADD_EVENT_LISTENER !== "function" ||
        typeof REMOVE_EVENT_LISTENER !== "function"
      ) {
        rejectWith(options.createInvalidSignalError());
        return;
      }
      try {
        Reflect.apply(ADD_EVENT_LISTENER, signal, [
          "abort",
          onAbort,
          { once: true },
        ]);
        listenerAdded = true;
      } catch {
        rejectWith(options.createInvalidSignalError());
        return;
      }
      const stateAfterListener = readTrustedAbortState(signal);
      if (stateAfterListener === undefined) {
        rejectWith(options.createInvalidSignalError());
        return;
      }
      if (initialState || stateAfterListener) {
        onAbort();
        return;
      }
    }

    if (options.timeoutMs !== undefined) {
      const createTimeoutError = options.createTimeoutError;
      if (
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        !createTimeoutError
      ) {
        rejectWith(options.createInvalidSignalError());
        return;
      }
      timeout = window.setTimeout(
        () => rejectWith(createTimeoutError()),
        options.timeoutMs,
      );
    }

    let pending: unknown;
    try {
      pending = start();
    } catch (error) {
      rejectWith(normalizeFailure(error, options.mapFailure));
      return;
    }

    let normalized: Promise<unknown>;
    try {
      normalized = Promise.resolve(pending);
    } catch (error) {
      rejectWith(normalizeFailure(error, options.mapFailure));
      return;
    }
    if (signal) trackTrustedAbortWork(signal, normalized);
    normalized.then(
      (value) => finish(() => resolve(value as T)),
      (error: unknown) => rejectWith(normalizeFailure(error, options.mapFailure)),
    );
  });
}

function trackTrustedAbortWork(
  signal: AbortSignal,
  pending: Promise<unknown>,
): void {
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  const previous = TRUSTED_ABORT_WORK.get(signal);
  const combined = previous
    ? Promise.all([previous, settled]).then(() => undefined)
    : settled;
  TRUSTED_ABORT_WORK.set(signal, combined);
  void combined.then(() => {
    if (TRUSTED_ABORT_WORK.get(signal) === combined) {
      TRUSTED_ABORT_WORK.delete(signal);
    }
  });
}

function normalizeFailure(
  error: unknown,
  mapFailure: ((error: unknown) => Error) | undefined,
): Error {
  if (mapFailure) return mapFailure(error);
  return error instanceof Error ? error : new Error("Asynchronous operation failed");
}
