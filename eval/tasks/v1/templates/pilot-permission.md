---
id: pilot-permission
repo: {{REPO_JSON}}
base: {{BASE_SHA}}
class: risky
scope: [src/permission.cjs]
protected: [checks/**]
context: [src/permission.cjs]
checks: [node checks/permission.cjs]
review: frontier
limits: {max_minutes: 10, max_attempts: 1}
---

## Objective
Make the exported canEdit function fail closed. The exact role string admin permits editing. The exact role string editor permits editing only when isOwner is the boolean true. All other roles and ownership representations deny editing.

## Acceptance criteria
- Return strict booleans. Unknown roles, alternate casing, whitespace and truthy non-boolean ownership never broaden editor permissions.
- The protected permission check passes. Change only src/permission.cjs, commit on the assigned result branch, and leave the worktree clean.
- This risky task requires an authorized frontier session and frontier review; creation does not grant availability or permission.
- Do not edit protected checks, install dependencies, push, merge, deploy or contact another provider.
