# ADR 0009: Distinguish complete read pages from evidence loss

Status: accepted for workload v3; historical outcomes remain immutable.

The real v2 repair case performed the required failure/edit/pass sequence but was rejected for an intentional ten-line read page. OpenCode 1.19.0 sets its read `truncated` flag for both normal pagination and byte-capped output. Treating every such flag as lost transcript evidence is incorrect.

Version the observer correction with new workload v3 assets. Keep v1/v2 assets byte-identical, retain their observer behavior and inspection, and never rewrite prior results. Private result format remains 1; supported suite versions are 1, 2 and 3. New admissions require the default v3 manifest.

Allow a flagged read only when an explicit positive integer page limit, effective offset, matching structured path/count/boundaries and exact complete rendered page establish delivery. This applies to file and directory pages. Byte caps, line truncation, timeout, ambiguous or malformed stream evidence and non-read truncation remain failures.

The multi-round workload still requires a full ledger read, observed grep, edit/check and multiple rounds. Require matching full-ledger display/path, lines 1–256, intact text and exact end-of-file rendering. Partial pages and offset tails remain recorded in accounting but cannot substitute for that full-context requirement. Protected checks, commands, budgets and promotion rules are unchanged.

Verify with sanitized positive/negative fixtures, pinned historical asset digests, real Git integration, strict source/installed-package manifest rejection, independent review and read-only saved-trace replay. No additional inference or public profile follows from this correction. A fresh real v3 qualification is separate future evidence.
