const SENSITIVE_KEY_SOURCE =
  String.raw`(?:api[\s_-]*key|access[\s_-]*(?:key|token)|client[\s_-]*secret|refresh[\s_-]*token|private[\s_-]*key|auth(?:orization|[\s_-]*token)?|token|secret|password|session(?:[\s_-]*(?:id|key|token))?|key)`;

const ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(?:^|[\s,{;])["']?(${SENSITIVE_KEY_SOURCE})["']?\s*(?::|=(?!=|>))\s*([^\r\n,;}]+)`,
  "gi",
);
const URL_CREDENTIAL_PATTERN = new RegExp(
  String.raw`(?:[?&#])${SENSITIVE_KEY_SOURCE}\s*=\s*[^&#\s"'<>]{4,}`,
  "i",
);
const SAFE_RUNTIME_IDENTIFIERS = new Set([
  "candidate",
  "input",
  "null",
  "record",
  "settings",
  "string",
  "true",
  "undefined",
  "unknown",
  "value",
]);

export function decodePercentLayers(value) {
  const values = [value];
  let current = value;
  for (let count = 0; count < 2; count += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      values.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return values;
}

function hasCredentialAssignment(value) {
  if (/[\r\n]/.test(value)) {
    return value.split(/\r\n?|\n/).some(hasCredentialAssignment);
  }
  if (
    /\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+(?!\$\{)[A-Za-z0-9._~+/-]{4,}/i.test(
      value,
    ) ||
    /\b(?:sk|xox[baprs]|gh[pousr])-[A-Za-z0-9_-]{12,}\b/.test(value)
  ) {
    return true;
  }
  ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(ASSIGNMENT_PATTERN)) {
    const normalizedName = match[1]
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    const isBareKey = normalizedName === "key";
    const raw = match[2].trim();
    if (raw.includes("${") || raw.length < 4) continue;
    const quoted =
      (raw.startsWith('"') && raw.includes('"', 1)) ||
      (raw.startsWith("'") && raw.includes("'", 1));
    const normalized = raw
      .replace(/^["'`]/, "")
      .replace(/["'`)]+$/, "")
      .trim();
    if (normalized.length < 4) continue;
    if (
      !quoted &&
      (/^[A-Za-z_$][\w$]*\.[\w$.]+$/.test(normalized) ||
        SAFE_RUNTIME_IDENTIFIERS.has(normalized.toLowerCase()) ||
        /^(?:string|number|boolean|unknown|PropertyKey|TranslationKey)(?:\s*\|\s*(?:undefined|null))*\b/.test(
          normalized,
        ) ||
        /^(?:await\s+)?[A-Za-z_$][\w$]*\s*\(/.test(normalized) ||
        /^(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[\w$]+)+\s*\(/.test(
          normalized,
        ) ||
        /^[A-Za-z_$][\w$]*\s+as\s+[A-Za-z_$][\w$]*$/.test(normalized) ||
        /^[A-Za-z_$][\w$]*(?:\[[^\]]+\])+(?:\.[\w$]+)*$/.test(
          normalized,
        ) ||
        /^typeof\s+/.test(normalized) ||
        /^[A-Za-z_$][\w$]*(?:\?\.[\w$]+|\.[\w$]+)+(?:\s*\?\?.*)?$/.test(
          normalized,
        ) ||
        /^[{[(]/.test(normalized))
    ) {
      continue;
    }
    if (isBareKey) {
      const credentialShaped =
        /^[a-z0-9_-]{12,}$/.test(normalized) ||
        /^[A-Za-z0-9+/_=-]{24,}$/.test(normalized);
      if (!credentialShaped) continue;
    }
    return true;
  }
  return false;
}

function hasCredentialUrl(value) {
  return (
    /(?:https?|ftp):\/\/[^/\s:@"'<>]+:[^/\s@"'<>]+@/i.test(value) ||
    URL_CREDENTIAL_PATTERN.test(value)
  );
}

function hasPrivatePath(value) {
  return (
    /(?:file:\/\/\/|\/)(?:Users\/[^/\s"'<>]+|home\/[^/\s"'<>]+|root)(?:[\\/]|$)/.test(
      value,
    ) ||
    /\b[A-Za-z]:[\\/][^\\/\r\n"'<>]+(?:[\\/][^\\/\r\n"'<>]+)*/.test(
      value,
    ) ||
    /\\\\[A-Za-z0-9._$-]{1,64}\\[A-Za-z0-9._$-]{1,64}(?:\\[^\\\r\n"'<>]+)*/.test(
      value,
    )
  );
}

export function sensitiveRuleIdsForText(text) {
  const decodedLayers = decodePercentLayers(text);
  const rules = [];
  if (decodedLayers.some(hasPrivatePath)) rules.push("home-path");
  if (decodedLayers.some(hasCredentialAssignment)) {
    rules.push("credential-value");
  }
  if (decodedLayers.some(hasCredentialUrl)) rules.push("credential-url");
  if (
    /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/.test(text)
  ) {
    rules.push("private-key-material");
  }
  return rules;
}
