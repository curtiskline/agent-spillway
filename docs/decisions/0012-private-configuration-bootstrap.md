# 0012: Allow qualification before task-class grants and initialize private config

Accepted 2026-10-13 after PR #5 merge and owner-authorized continuation.

Empty qualified_classes permits safe service startup and explicit qualification, while all existing class gates keep tasks disabled. Requiring a nonempty list at startup encouraged unsupported assertions before testing. No task permissions are inferred from tool qualification or fixtures.

Factor read-only configuration planning from existing data-directory preparation. A standalone initializer validates an explicit private input and creates only an exclusive new private root/config/data with local-only defaults and empty grants. Preserve existing config/service/queue state and reject unsafe filesystem substitutions. No automatic credentials, calls, installs or publication.

See [contracts and ordered ownership](../PHASE3_CONFIGURATION.md).
