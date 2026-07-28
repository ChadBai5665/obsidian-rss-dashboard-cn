import {
  X_PROFILE_MAX_ARRAY_ENTRIES,
  X_PROFILE_MAX_OBJECT_PROPERTIES,
  X_PROFILE_MAX_WALK_DEPTH,
  X_PROFILE_MAX_WALK_NODES,
} from "./x-profile";

export type XProfileShapeIssue =
  | "no-candidate"
  | "required-field-invalid"
  | "identity-conflict"
  | "optional-field-conflict"
  | "unsafe-structure"
  | "unknown-shape";

export interface XProfileShapeDiagnostic {
  issue: XProfileShapeIssue;
  visitedContainers: number;
  candidateCount: number;
  hasLegacyContainer: boolean;
  hasCoreContainer: boolean;
}

type ValueCategory =
  | "undefined"
  | "null"
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "object"
  | "array"
  | "function";

type RelevantKey =
  | "rest_id"
  | "legacy"
  | "core"
  | "screen_name"
  | "name"
  | "profile_image_url_https"
  | "description"
  | "verified"
  | "is_blue_verified"
  | "avatar"
  | "image_url"
  | "profile_bio"
  | "verification";

interface ProjectedContainer {
  valueCategories: Partial<Record<RelevantKey, ValueCategory>>;
  objectContainers: Partial<Record<RelevantKey, object>>;
}

interface WalkEntry {
  value: object;
  depth: number;
}

interface ShapeFacts {
  visitedContainers: number;
  candidateCount: number;
  hasLegacyContainer: boolean;
  hasCoreContainer: boolean;
  hasCandidateHint: boolean;
  requiredFieldInvalid: boolean;
  optionalFieldInvalid: boolean;
  requiredSignatures: Set<string>;
  optionalSignatures: Set<string>;
}

const RELEVANT_KEYS = new Set<RelevantKey>([
  "rest_id",
  "legacy",
  "core",
  "screen_name",
  "name",
  "profile_image_url_https",
  "description",
  "verified",
  "is_blue_verified",
  "avatar",
  "image_url",
  "profile_bio",
  "verification",
]);

/** Produces a bounded structural projection without retaining provider values. */
export function diagnoseXProfileShape(payload: unknown): XProfileShapeDiagnostic {
  const facts: ShapeFacts = {
    visitedContainers: 0,
    candidateCount: 0,
    hasLegacyContainer: false,
    hasCoreContainer: false,
    hasCandidateHint: false,
    requiredFieldInvalid: false,
    optionalFieldInvalid: false,
    requiredSignatures: new Set<string>(),
    optionalSignatures: new Set<string>(),
  };
  if (!isObject(payload)) return frozenDiagnostic("no-candidate", facts);

  const projections: ProjectedContainer[] = [];
  const projectionsByObject = new WeakMap<object, ProjectedContainer>();
  const seen = new WeakSet<object>();
  const stack: WalkEntry[] = [{ value: payload, depth: 0 }];

  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      if (current.depth > X_PROFILE_MAX_WALK_DEPTH) {
        return frozenDiagnostic("unsafe-structure", facts);
      }
      if (seen.has(current.value)) continue;
      seen.add(current.value);
      facts.visitedContainers += 1;
      if (facts.visitedContainers > X_PROFILE_MAX_WALK_NODES) {
        return frozenDiagnostic("unsafe-structure", facts);
      }

      const children: object[] = [];
      const projection = projectContainer(current.value, children);
      projections.push(projection);
      projectionsByObject.set(current.value, projection);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) stack.push({ value: child, depth: current.depth + 1 });
      }
    }

    for (const projection of projections) {
      collectFacts(projection, projectionsByObject, facts);
    }
    return frozenDiagnostic(classifyIssue(facts), facts);
  } catch {
    return frozenDiagnostic("unsafe-structure", facts);
  }
}

function projectContainer(
  value: object,
  children: object[],
): ProjectedContainer {
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !(array && prototype === Array.prototype)
  ) {
    throw new Error("unsafe-structure");
  }

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new Error("unsafe-structure");
  }
  if (keys.length > X_PROFILE_MAX_OBJECT_PROPERTIES) {
    throw new Error("unsafe-structure");
  }
  if (array) {
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      lengthDescriptor.value > X_PROFILE_MAX_ARRAY_ENTRIES
    ) {
      throw new Error("unsafe-structure");
    }
  }

  const projection: ProjectedContainer = {
    valueCategories: {},
    objectContainers: {},
  };
  for (const rawKey of keys) {
    if (typeof rawKey !== "string" || (array && rawKey === "length")) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, rawKey);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("unsafe-structure");
    }
    const entry = descriptor.value as unknown;
    if (isObject(entry)) children.push(entry);
    if (!isRelevantKey(rawKey)) continue;
    projection.valueCategories[rawKey] = valueCategory(entry);
    if (isObject(entry)) projection.objectContainers[rawKey] = entry;
  }
  return projection;
}

function collectFacts(
  projection: ProjectedContainer,
  projectionsByObject: WeakMap<object, ProjectedContainer>,
  facts: ShapeFacts,
): void {
  const restIdCategory = presentCategory(projection, "rest_id");
  const legacyCategory = presentCategory(projection, "legacy");
  const coreCategory = presentCategory(projection, "core");
  facts.hasLegacyContainer ||= isContainerCategory(legacyCategory);
  facts.hasCoreContainer ||= isContainerCategory(coreCategory);
  facts.hasCandidateHint ||= restIdCategory !== undefined &&
    (legacyCategory !== undefined || coreCategory !== undefined);

  collectCandidate(
    "legacy",
    projection,
    projectionsByObject,
    restIdCategory,
    facts,
  );
  collectCandidate(
    "core",
    projection,
    projectionsByObject,
    restIdCategory,
    facts,
  );
}

function collectCandidate(
  kind: "legacy" | "core",
  parent: ProjectedContainer,
  projectionsByObject: WeakMap<object, ProjectedContainer>,
  restIdCategory: ValueCategory | undefined,
  facts: ShapeFacts,
): void {
  const containerCategory = presentCategory(parent, kind);
  const containerObject = parent.objectContainers[kind];
  const container = containerObject && projectionsByObject.get(containerObject);
  if (!container || containerCategory === undefined) {
    if (restIdCategory !== undefined && containerCategory !== undefined) {
      facts.requiredFieldInvalid = true;
    }
    return;
  }

  const handleCategory = presentCategory(container, "screen_name");
  const nameCategory = presentCategory(container, "name");
  if (
    restIdCategory === undefined ||
    handleCategory === undefined ||
    nameCategory === undefined
  ) {
    if (
      restIdCategory !== undefined &&
      (handleCategory !== undefined || nameCategory !== undefined)
    ) {
      facts.requiredFieldInvalid = true;
    }
    return;
  }

  facts.candidateCount += 1;
  const requiredSignature = [
    restIdCategory,
    handleCategory,
    nameCategory,
  ].join(":");
  facts.requiredSignatures.add(requiredSignature);
  if (
    restIdCategory !== "string" ||
    handleCategory !== "string" ||
    nameCategory !== "string"
  ) {
    facts.requiredFieldInvalid = true;
  }

  const optional = optionalCategories(kind, parent, container, projectionsByObject);
  facts.optionalSignatures.add(optional.signature);
  facts.optionalFieldInvalid ||= optional.invalid;
}

function optionalCategories(
  kind: "legacy" | "core",
  parent: ProjectedContainer,
  container: ProjectedContainer,
  projectionsByObject: WeakMap<object, ProjectedContainer>,
): { signature: string; invalid: boolean } {
  if (kind === "legacy") {
    const avatar = presentCategory(container, "profile_image_url_https");
    const description = presentCategory(container, "description");
    const verified = presentCategory(container, "verified");
    const blueVerified = presentCategory(parent, "is_blue_verified");
    return {
      signature: [avatar, description, verified, blueVerified].join(":"),
      invalid: invalidOptionalText(avatar) ||
        invalidOptionalText(description) ||
        invalidOptionalBoolean(verified) ||
        invalidOptionalBoolean(blueVerified),
    };
  }

  const avatar = nestedCategory(parent, "avatar", "image_url", projectionsByObject);
  const description = nestedCategory(
    parent,
    "profile_bio",
    "description",
    projectionsByObject,
  );
  const verified = nestedCategory(
    parent,
    "verification",
    "verified",
    projectionsByObject,
  );
  return {
    signature: [avatar.category, description.category, verified.category].join(":"),
    invalid: avatar.invalid ||
      description.invalid ||
      verified.invalid ||
      invalidOptionalText(avatar.category) ||
      invalidOptionalText(description.category) ||
      invalidOptionalBoolean(verified.category),
  };
}

function nestedCategory(
  parent: ProjectedContainer,
  containerKey: "avatar" | "profile_bio" | "verification",
  valueKey: "image_url" | "description" | "verified",
  projectionsByObject: WeakMap<object, ProjectedContainer>,
): { category: ValueCategory | undefined; invalid: boolean } {
  const category = presentCategory(parent, containerKey);
  if (category === undefined || category === "null" || category === "string") {
    return { category, invalid: false };
  }
  const containerObject = parent.objectContainers[containerKey];
  const container = containerObject && projectionsByObject.get(containerObject);
  if (!container || category !== "object") {
    return { category, invalid: true };
  }
  return {
    category: presentCategory(container, valueKey),
    invalid: false,
  };
}

function classifyIssue(facts: ShapeFacts): XProfileShapeIssue {
  if (facts.requiredFieldInvalid) return "required-field-invalid";
  if (facts.candidateCount === 0) {
    return facts.hasCandidateHint ? "required-field-invalid" : "no-candidate";
  }
  if (facts.optionalFieldInvalid) return "optional-field-conflict";
  if (facts.candidateCount > 1) {
    if (facts.requiredSignatures.size > 1) return "identity-conflict";
    if (facts.optionalSignatures.size > 1) return "optional-field-conflict";
    return "identity-conflict";
  }
  return "unknown-shape";
}

function presentCategory(
  projection: ProjectedContainer,
  key: RelevantKey,
): ValueCategory | undefined {
  const category = projection.valueCategories[key];
  return category === "undefined" ? undefined : category;
}

function invalidOptionalText(category: ValueCategory | undefined): boolean {
  return category !== undefined && category !== "null" && category !== "string";
}

function invalidOptionalBoolean(category: ValueCategory | undefined): boolean {
  return category !== undefined && category !== "null" && category !== "boolean" &&
    category !== "string";
}

function isContainerCategory(category: ValueCategory | undefined): boolean {
  return category === "object" || category === "array" || category === "function";
}

function isRelevantKey(value: string): value is RelevantKey {
  return RELEVANT_KEYS.has(value as RelevantKey);
}

function valueCategory(value: unknown): ValueCategory {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function frozenDiagnostic(
  issue: XProfileShapeIssue,
  facts: ShapeFacts,
): XProfileShapeDiagnostic {
  return Object.freeze({
    issue,
    visitedContainers: facts.visitedContainers,
    candidateCount: facts.candidateCount,
    hasLegacyContainer: facts.hasLegacyContainer,
    hasCoreContainer: facts.hasCoreContainer,
  });
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") &&
    value !== null;
}
