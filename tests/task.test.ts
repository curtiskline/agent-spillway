import { describe, expect, it } from "vitest";
import { lintTask, parseTask } from "../src/task.js";
const task = (
  extra = "",
  body = "## Objective\nFix quoting.\n\n## Acceptance criteria\n- Quotes preserved.",
) =>
  `---\nrepo: /tmp/pilot\nbase: main\nclass: small-fix\nscope: [src/**]\ncontext: [src/csv.ts]\nchecks: [npm test]\n${extra}---\n${body}\n`;
describe("task admission parsing", () => {
  it("normalizes defaults and generates safe IDs", () => {
    const spec = parseTask(task());
    expect(spec.id).toMatch(/^task-[a-f0-9-]+$/);
    expect(spec.after).toEqual([]);
    expect(spec.protected).toEqual([]);
    expect(spec.limits).toEqual({ max_minutes: 30, max_attempts: 2 });
    expect(spec.review).toBe("default");
  });
  it("preserves owner check commands as text", () => {
    expect(parseTask(task("id: quote-fix\n")).checks).toEqual(["npm test"]);
  });
  it.each([
    ["unknown fields", "secret: value\n"],
    ["duplicate keys", "base: other\n"],
    ["unsafe IDs", "id: ../bad\n"],
    ["traversal", "protected: [src/../private]\n"],
    ["absolute paths", "protected: [/etc/passwd]\n"],
    ["Windows paths", 'protected: ["C:/file"]\n'],
    ["backslash paths", "protected: ['src\\file']\n"],
    ["aliases", "after: &deps []\nprotected: *deps\n"],
    ["self dependency", "id: self\nafter: [self]\n"],
    ["duplicate dependencies", "after: [other, other]\n"],
    ["unknown limit", "limits: {timeout: 10}\n"],
  ])("rejects %s", (_name, extra) => {
    expect(() => parseTask(task(extra))).toThrow();
  });
  it("rejects missing and empty required body sections", () => {
    expect(() =>
      parseTask(task("", "## Objective\n\n## Acceptance criteria\nTests")),
    ).toThrow(/Objective/);
    expect(() => parseTask(task("", "## Objective\nFix"))).toThrow(
      /Acceptance/,
    );
    expect(() =>
      parseTask(
        task(
          "",
          "## Objective\nFix\n## Acceptance criteria\n\n## Notes\nSomething",
        ),
      ),
    ).toThrow(/Acceptance/);
  });
  it("requires explicit no-check justification and forces frontier review", () => {
    const raw = task("review: checks-only\n").replace(
      "checks: [npm test]",
      "checks: []",
    );
    expect(() => parseTask(raw)).toThrow(/justification/);
    const lint = lintTask(
      raw.replace(
        "review:",
        "no_checks_justification: Owner visual inspection required\nreview:",
      ),
    );
    expect(lint.spec?.review).toBe("frontier");
    expect(lint.warnings).toHaveLength(1);
  });
  it("rejects oversized Markdown and reports safe lint errors", () => {
    expect(lintTask("x".repeat(256 * 1024 + 1)).errors).toEqual([
      "Task must be text under 256 KiB",
    ]);
    expect(lintTask(task("review: unknowable\n")).errors.length).toBe(1);
  });
});
