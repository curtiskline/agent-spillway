import type { TaskSpec } from "./contracts.js";

/** Measurements of declarations only, with no text or eligibility judgments. */
export interface TaskSpecFeatures {
  bodyBytes: number;
  scopePatterns: number;
  contextFiles: number;
  checkCommands: number;
  hasNoChecksJustification: boolean;
}

function declarations(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    Number.isSafeInteger(value.length) &&
    // Serialized legacy arrays must be dense; holes are not declarations.
    Object.keys(value).length === value.length &&
    value.every(
      (entry: unknown) => typeof entry === "string" && entry.trim().length > 0,
    )
  );
}

export function deriveTaskSpecFeatures(spec: TaskSpec): TaskSpecFeatures | null {
  try {
    const value: unknown = spec;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fields = value as Record<string, unknown>;
    const { body, scope, context, checks, no_checks_justification: justification } = fields;
    if (
      typeof body !== "string" || !declarations(scope) ||
      !declarations(context) || !declarations(checks) ||
      (justification !== undefined && typeof justification !== "string")
    ) return null;
    const features = {
      bodyBytes: Buffer.byteLength(body, "utf8"),
      scopePatterns: scope.length,
      contextFiles: context.length,
      checkCommands: checks.length,
      hasNoChecksJustification:
        typeof justification === "string" && justification.trim().length > 0,
    };
    const valid = [features.bodyBytes, features.scopePatterns, features.contextFiles, features.checkCommands]
      .every((count) => Number.isSafeInteger(count) && count >= 0);
    return valid ? features : null;
  } catch {
    // Malformed legacy objects/accessors cannot inject values or error text.
    return null;
  }
}
