import { describe, expect, it } from "vitest";

import {
  X_PROFILE_MAX_ARRAY_ENTRIES,
  X_PROFILE_MAX_OBJECT_PROPERTIES,
  X_PROFILE_MAX_WALK_DEPTH,
  X_PROFILE_MAX_WALK_NODES,
} from "../../../../src/sources/tikhub/x-profile";
import {
  diagnoseXProfileShape,
  type XProfileShapeDiagnostic,
} from "../../../../src/sources/tikhub/x-profile-shape-diagnostic";

const SENTINEL = "SECRET_NAVAL_VALUE";
const SENTINEL_URL = `https://provider.example/${SENTINEL}`;
const PUBLIC_KEYS = [
  "issue",
  "visitedContainers",
  "candidateCount",
  "hasLegacyContainer",
  "hasCoreContainer",
];

function expectValueFree(diagnostic: XProfileShapeDiagnostic): void {
  const serialized = JSON.stringify(diagnostic);
  expect(Object.keys(diagnostic)).toEqual(PUBLIC_KEYS);
  expect(serialized).not.toContain(SENTINEL);
  expect(serialized).not.toContain(SENTINEL_URL);
  expect(serialized).not.toContain("providerSecretField");
  expect(Object.isFrozen(diagnostic)).toBe(true);
}

describe("diagnoseXProfileShape", () => {
  it("returns only the documented projection for a payload without candidates", () => {
    const diagnostic = diagnoseXProfileShape({
      providerSecretField: SENTINEL,
      providerUrl: SENTINEL_URL,
    });

    expect(diagnostic).toEqual({
      issue: "no-candidate",
      visitedContainers: 1,
      candidateCount: 0,
      hasLegacyContainer: false,
      hasCoreContainer: false,
    });
    expectValueFree(diagnostic);
  });

  it("reports a required-field-invalid shape without retaining provider values", () => {
    const diagnostic = diagnoseXProfileShape({
      wrapper: {
        rest_id: { providerSecretField: SENTINEL },
        legacy: {
          screen_name: SENTINEL,
          name: SENTINEL,
          profile_image_url_https: SENTINEL_URL,
        },
      },
    });

    expect(diagnostic).toEqual({
      issue: "required-field-invalid",
      visitedContainers: 4,
      candidateCount: 1,
      hasLegacyContainer: true,
      hasCoreContainer: false,
    });
    expectValueFree(diagnostic);
  });

  it("does not invoke accessors and collapses them to unsafe-structure", () => {
    let getterCalls = 0;
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, "legacy", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return SENTINEL;
      },
    });

    const diagnostic = diagnoseXProfileShape(payload);

    expect(getterCalls).toBe(0);
    expect(diagnostic).toEqual({
      issue: "unsafe-structure",
      visitedContainers: 1,
      candidateCount: 0,
      hasLegacyContainer: false,
      hasCoreContainer: false,
    });
    expectValueFree(diagnostic);
  });

  it.each([
    ["prototype reflection", new Proxy({}, {
      getPrototypeOf() {
        throw new Error(SENTINEL);
      },
    })],
    ["own-key reflection", new Proxy({}, {
      ownKeys() {
        throw new Error(SENTINEL);
      },
    })],
    ["descriptor reflection", new Proxy({ providerSecretField: SENTINEL }, {
      getOwnPropertyDescriptor() {
        throw new Error(SENTINEL);
      },
    })],
  ])("collapses a proxy throwing during %s to unsafe-structure", (_name, payload) => {
    const diagnostic = diagnoseXProfileShape(payload);

    expect(diagnostic.issue).toBe("unsafe-structure");
    expectValueFree(diagnostic);
  });

  it("terminates cycles without duplicating visited containers", () => {
    const payload: Record<string, unknown> = {
      providerSecretField: SENTINEL,
    };
    payload.self = payload;

    const diagnostic = diagnoseXProfileShape(payload);

    expect(diagnostic).toEqual({
      issue: "no-candidate",
      visitedContainers: 1,
      candidateCount: 0,
      hasLegacyContainer: false,
      hasCoreContainer: false,
    });
    expectValueFree(diagnostic);
  });

  it("uses the parser depth limit and fails closed beyond it", () => {
    const root: unknown[] = [];
    let current = root;
    for (let depth = 0; depth <= X_PROFILE_MAX_WALK_DEPTH; depth += 1) {
      const child: unknown[] = [];
      current.push(child);
      current = child;
    }
    current.push(SENTINEL);

    const diagnostic = diagnoseXProfileShape(root);

    expect(diagnostic.issue).toBe("unsafe-structure");
    expect(diagnostic.visitedContainers).toBe(X_PROFILE_MAX_WALK_DEPTH + 1);
    expectValueFree(diagnostic);
  });

  it("uses the parser array-entry limit and fails closed above it", () => {
    const payload = new Array(X_PROFILE_MAX_ARRAY_ENTRIES + 1);
    payload[0] = SENTINEL;

    const diagnostic = diagnoseXProfileShape(payload);

    expect(diagnostic.issue).toBe("unsafe-structure");
    expect(diagnostic.visitedContainers).toBe(1);
    expectValueFree(diagnostic);
  });

  it("uses the parser visited-container limit and fails closed above it", () => {
    const payload = Array.from(
      { length: 4 },
      () => Array.from(
        { length: 7_000 },
        () => Object.create(null) as object,
      ),
    );

    const diagnostic = diagnoseXProfileShape(payload);

    expect(diagnostic.issue).toBe("unsafe-structure");
    expect(diagnostic.visitedContainers).toBe(X_PROFILE_MAX_WALK_NODES + 1);
    expectValueFree(diagnostic);
  });

  it("uses the parser object-property limit and fails closed above it", () => {
    const payload = Object.fromEntries(
      Array.from(
        { length: X_PROFILE_MAX_OBJECT_PROPERTIES + 1 },
        (_, index) => [`providerSecretField${index}`, SENTINEL],
      ),
    );

    const diagnostic = diagnoseXProfileShape(payload);

    expect(diagnostic.issue).toBe("unsafe-structure");
    expect(diagnostic.visitedContainers).toBe(1);
    expectValueFree(diagnostic);
  });
});
