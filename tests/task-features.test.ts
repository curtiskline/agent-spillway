import { describe, expect, it } from "vitest";
import { deriveTaskSpecFeatures } from "../src/task-features.js";
import type { TaskSpec } from "../src/contracts.js";

const spec = (): TaskSpec => ({
  id: "private-id", repo: "/private/repo", base: "main", class: "small-fix",
  after: [], scope: ["src/**"], protected: [], context: ["src/value.ts"],
  checks: ["node protected-check.cjs"], review: "default",
  limits: { max_minutes: 3, max_attempts: 1 }, body: "é🙂\n",
});
describe("declared-only task spec features", () => {
  it("counts exact UTF-8 bytes and declarations without deduplicating or exposing text", () => {
    const input = spec();
    input.scope = ["src/**", "src/**"];
    input.context = ["src/value.ts", "src/value.ts"];
    input.checks.push(input.checks[0]!);
    input.no_checks_justification = "private explanation";
    const before = JSON.stringify(input);
    const features = deriveTaskSpecFeatures(input);
    expect(features).toEqual({ bodyBytes: 7, scopePatterns: 2, contextFiles: 2,
      checkCommands: 2, hasNoChecksJustification: true });
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(features)).not.toMatch(/private|src\/|protected-check|é|🙂/);
  });
  it.each([undefined, "", " \t\n"])("treats blank or absent justification as absent: %s", (value) => {
    const input = { ...spec(), body: "", scope: [], context: [], checks: [], no_checks_justification: value };
    expect(deriveTaskSpecFeatures(input)).toEqual({ bodyBytes: 0, scopePatterns: 0,
      contextFiles: 0, checkCommands: 0, hasNoChecksJustification: false });
  });
  it.each([1024, 1025, 4096, 4097])("preserves exact body size %s", (bodyBytes) => {
    expect(deriveTaskSpecFeatures({ ...spec(), body: "x".repeat(bodyBytes) })?.bodyBytes).toBe(bodyBytes);
  });
  it("measures UTF-8 bytes rather than characters, markdown lines or surrounding raw task content", () => {
    expect(deriveTaskSpecFeatures({ ...spec(), body: "🙂".repeat(256) })?.bodyBytes).toBe(1024);
    expect(deriveTaskSpecFeatures({ ...spec(), body: "🙂".repeat(1024) })?.bodyBytes).toBe(4096);
    expect(deriveTaskSpecFeatures({ ...spec(), body: "x\r\n" })?.bodyBytes).toBe(3);
  });
  const malformed: unknown[] = [
    null, undefined, [], "spec", {},
    { ...spec(), body: null }, { ...spec(), body: 123 },
    { ...spec(), scope: "src/**" }, { ...spec(), scope: ["src/**", null] },
    { ...spec(), scope: [""] }, { ...spec(), context: [" "] },
    { ...spec(), context: undefined }, { ...spec(), checks: ["valid", 1] },
    { ...spec(), checks: new Array<string>(2) },
    { ...spec(), no_checks_justification: null },
    { ...spec(), no_checks_justification: true },
  ];
  it.each(malformed.map((value, index) => ({ value, index })))("returns unknown for malformed measured fields $index", ({ value }) => {
    expect(deriveTaskSpecFeatures(value as TaskSpec)).toBeNull();
  });
  it("returns unknown on failing legacy accessors without coercion or error propagation", () => {
    const input = spec();
    Object.defineProperty(input, "checks", { get: () => { throw new Error("private error"); } });
    expect(deriveTaskSpecFeatures(input)).toBeNull();
  });
  it("ignores unrelated fields and creates a closed fresh object instead of spreading private data", () => {
    const input = { ...spec(), extra: "private secret", bodyBytes: "injected", taskSpec: { secret: "private" } };
    const result = deriveTaskSpecFeatures(input);
    expect(Object.keys(result!)).toEqual(["bodyBytes", "scopePatterns", "contextFiles", "checkCommands", "hasNoChecksJustification"]);
    for (const [key, value] of Object.entries(result!))
      if (key !== "hasNoChecksJustification") expect(Number.isSafeInteger(value) && Number(value) >= 0).toBe(true);
  });
});
