---
id: pilot-slug
repo: {{REPO_JSON}}
base: {{BASE_SHA}}
class: small-fix
scope: [src/slug.cjs]
protected: [checks/**]
context: [src/slug.cjs]
checks: [node checks/slug.cjs]
review: default
limits: {max_minutes: 10, max_attempts: 2}
---

## Objective
Fix the exported slug function. Accept strings only, lowercase them, replace each run of characters outside ASCII a-z and 0-9 with one hyphen, and remove leading and trailing hyphens. Do not transliterate accented or other Unicode letters.

## Acceptance criteria
- Non-string inputs throw TypeError; strings containing no ASCII letters or digits produce an empty string.
- Repeated separators collapse, digits survive, and edge separators disappear.
- The protected slug check passes. Change only src/slug.cjs, commit on the assigned result branch, and leave the worktree clean.
- Do not edit protected checks, install dependencies, push, merge, deploy or contact another provider.
