# 0002: Fail closed on reviews and recovery

Accepted 2026-10-12. Explicit checks-only opt-in is needed for the Phase 1 sample. Default local and frontier tiers hold after objective verification because review execution is Phase 2. Test weakening/risky changes force frontier review; owner acceptance requires a ready immutable verified result. Interrupted attempts become uncertain and hold; workers are never silently rerun. ADR 0004 strengthens recovery: even committed work holds because orphan process liveness cannot be proven.

This preserves the final design's acceptance rules while delivering an early usable pipeline. The tradeoff is that most real tasks will need later review support before becoming ready.
