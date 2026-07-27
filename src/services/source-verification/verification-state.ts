export type VerificationState<T> =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "checking" }>
  | Readonly<{ status: "success"; value: T }>
  | Readonly<{ status: "warning"; value: T; code: string }>
  | Readonly<{ status: "failure"; code: string }>;

/**
 * Keeps async verification completions tied to the input that started them.
 * Call invalidate when a modal is cancelled or closed.
 */
export class VerificationController<T> {
  private generation = 0;
  private checkingInput: string | undefined;
  private state: VerificationState<T> = freezeState({ status: "idle" });

  begin(input: string): number {
    if (this.state.status === "checking" && this.checkingInput === input) {
      return this.generation;
    }

    this.generation += 1;
    this.checkingInput = input;
    this.state = freezeState({ status: "checking" });
    return this.generation;
  }

  succeed(token: number, value: T): boolean {
    return this.complete(token, freezeState({ status: "success", value }));
  }

  warn(token: number, value: T, code: string): boolean {
    if (typeof code !== "string") return false;
    return this.complete(token, freezeState({ status: "warning", value, code }));
  }

  fail(token: number, code: string): boolean {
    if (typeof code !== "string") return false;
    return this.complete(token, freezeState({ status: "failure", code }));
  }

  invalidate(): void {
    this.generation += 1;
    this.checkingInput = undefined;
    this.state = freezeState({ status: "idle" });
  }

  snapshot(): VerificationState<T> {
    return this.state;
  }

  canSubscribe(): boolean {
    return (
      this.state.status === "success" ||
      (this.state.status === "warning" && this.state.code === "empty-feed")
    );
  }

  private complete(token: number, state: VerificationState<T>): boolean {
    if (token !== this.generation || this.state.status !== "checking") {
      return false;
    }

    this.checkingInput = undefined;
    this.state = state;
    return true;
  }
}

function freezeState<T>(state: VerificationState<T>): VerificationState<T> {
  return Object.freeze(state);
}
