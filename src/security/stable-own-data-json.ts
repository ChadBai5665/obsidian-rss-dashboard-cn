const MAX_CANONICAL_DEPTH = 128;
const MAX_CANONICAL_NODES = 1_000_000;

export class StableOwnDataError extends Error {
  constructor() {
    super("Invalid own-data JSON value.");
    this.name = "StableOwnDataError";
  }
}

export function cloneStableOwnData<T>(value: T): T {
  return normalizeOwnData(value, new Set(), { nodes: 0 }, 0, false) as T;
}

export function stableOwnDataJson(
  value: unknown,
  options: { omitRootKeys?: ReadonlySet<string> } = {},
): string {
  const normalized = normalizeOwnData(
    value,
    new Set(),
    { nodes: 0 },
    0,
    false,
    options.omitRootKeys,
  );
  return JSON.stringify(normalized);
}

function normalizeOwnData(
  value: unknown,
  ancestors: Set<object>,
  budget: { nodes: number },
  depth: number,
  inArray: boolean,
  omitRootKeys?: ReadonlySet<string>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value === undefined) return inArray ? null : undefined;
  if (typeof value !== "object") throw new StableOwnDataError();
  if (
    depth > MAX_CANONICAL_DEPTH ||
    ancestors.has(value) ||
    ++budget.nodes > MAX_CANONICAL_NODES
  ) {
    throw new StableOwnDataError();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new StableOwnDataError();
      }
      const length: unknown = Object.getOwnPropertyDescriptor(
        value,
        "length",
      )?.value;
      const keys = Reflect.ownKeys(value);
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        keys.length !== length + 1 ||
        !keys.includes("length")
      ) {
        throw new StableOwnDataError();
      }
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor)) {
          throw new StableOwnDataError();
        }
        output.push(
          normalizeOwnData(
            descriptor.value,
            ancestors,
            budget,
            depth + 1,
            true,
          ),
        );
      }
      return output;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StableOwnDataError();
    }
    const output = Object.create(null) as Record<string, unknown>;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new StableOwnDataError();
    }
    for (const key of (keys as string[]).sort()) {
      if (depth === 0 && omitRootKeys?.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new StableOwnDataError();
      }
      const normalized = normalizeOwnData(
        descriptor.value,
        ancestors,
        budget,
        depth + 1,
        false,
      );
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}
