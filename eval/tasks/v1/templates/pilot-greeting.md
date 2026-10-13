---
id: pilot-greeting
repo: {{REPO_JSON}}
base: {{BASE_SHA}}
class: mechanical
scope: [src/greeting.cjs]
protected: [checks/**]
context: [src/greeting.cjs]
checks: [node checks/greeting.cjs]
review: default
limits: {max_minutes: 10, max_attempts: 2}
---

## Objective
Make the exported greeting function return `Hello, NAME!` after trimming the supplied string name. Preserve the name's Unicode characters and internal spaces.

## Acceptance criteria
- Non-string names and empty names after trimming throw TypeError.
- Valid names produce exactly the requested punctuation and spacing.
- The protected greeting check passes. Change only src/greeting.cjs, commit on the assigned result branch, and leave the worktree clean.
- Do not edit protected checks, install dependencies, push, merge, deploy or contact another provider.
