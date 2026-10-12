import { randomUUID } from "node:crypto";
import { parseDocument, visit, isAlias } from "yaml";
import { z } from "zod";
import { SpillwayError, type TaskSpec } from "./contracts.js";

export const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const taskClass = z.enum([
  "tests",
  "small-fix",
  "mechanical",
  "small-feature",
  "risky",
  "design",
]);
export const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !Array.from(value).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      !/^[A-Za-z]:/.test(value) &&
      !value.split("/").some((part) => part === ".." || part === "") &&
      !value.startsWith("~") &&
      !value.startsWith("!") &&
      ![...value].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ),
    "must be a repository-relative POSIX path without traversal, negation, or controls",
  );
const text = z.string().trim().min(1).max(16384);
const taskSchema = z
  .object({
    id: identifier.optional(),
    repo: text,
    base: text,
    class: taskClass,
    after: z.array(identifier).max(100).default([]),
    scope: z.array(relativePath).min(1).max(100),
    protected: z.array(relativePath).max(100).default([]),
    context: z.array(relativePath).min(1).max(100),
    checks: z.array(text).max(100),
    review: z
      .enum(["default", "checks-only", "local", "frontier"])
      .default("default"),
    no_checks_justification: text.optional(),
    limits: z
      .object({
        max_minutes: z.number().int().min(1).max(1440).default(30),
        max_attempts: z.number().int().min(1).max(10).default(2),
      })
      .strict()
      .default({}),
  })
  .strict();

/** Parse YAML without expansion, duplicate keys, or silent unknown fields. */
export function parseYaml(input: string): unknown {
  const document = parseDocument(input, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length)
    throw new SpillwayError(
      "invalid_yaml",
      "Invalid YAML (including duplicate keys)",
    );
  visit(document, (_key, node) => {
    if (
      isAlias(node) ||
      (typeof node === "object" &&
        node !== null &&
        "anchor" in node &&
        node.anchor)
    )
      throw new SpillwayError(
        "invalid_yaml",
        "YAML aliases and anchors are not allowed",
      );
  });
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

export function parseTask(markdown: string): TaskSpec {
  if (typeof markdown !== "string" || Buffer.byteLength(markdown) > 256 * 1024)
    throw new SpillwayError("invalid_task", "Task must be text under 256 KiB");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
    markdown,
  );
  if (!match)
    throw new SpillwayError(
      "invalid_task",
      "Task must begin with YAML frontmatter",
    );
  const result = taskSchema.safeParse(parseYaml(match[1]!));
  if (!result.success)
    throw new SpillwayError(
      "invalid_task",
      result.error.issues
        .map(
          (issue) =>
            `${issue.path.join(".") || "frontmatter"}: ${issue.message}`,
        )
        .join("; "),
    );
  const body = match[2]!.trim();
  for (const heading of ["Objective", "Acceptance criteria"]) {
    const section = new RegExp(
      `^## ${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^#{1,2} |$(?![\\s\\S]))`,
      "mi",
    ).exec(body);
    if (!section?.[1]?.trim())
      throw new SpillwayError(
        "invalid_task",
        `A nonempty ## ${heading} section is required`,
      );
  }
  const spec: TaskSpec = {
    ...result.data,
    id: result.data.id ?? `task-${randomUUID()}`,
    body,
  };
  if (
    new Set(spec.after).size !== spec.after.length ||
    spec.after.includes(spec.id)
  )
    throw new SpillwayError(
      "invalid_task",
      "Dependencies must be unique and cannot refer to this task",
    );
  if (spec.checks.length === 0) {
    if (!spec.no_checks_justification)
      throw new SpillwayError(
        "invalid_task",
        "Tasks without checks require no_checks_justification",
      );
    spec.review = "frontier";
  }
  return spec;
}

export function lintTask(markdown: string): {
  spec?: TaskSpec;
  errors: string[];
  warnings: string[];
} {
  try {
    const spec = parseTask(markdown);
    const warnings: string[] = [];
    if (!spec.checks.length)
      warnings.push("No checks: frontier review is required");
    if (spec.class === "design")
      warnings.push("Design tasks are planner work and cannot be dispatched");
    if (spec.scope.some((path) => path === "**" || path === "**/*"))
      warnings.push(
        "Scope covers the entire repository; prefer a handful of files",
      );
    return { spec, errors: [], warnings };
  } catch (error) {
    return {
      errors: [
        error instanceof SpillwayError
          ? error.message
          : "Task could not be parsed",
      ],
      warnings: [],
    };
  }
}
