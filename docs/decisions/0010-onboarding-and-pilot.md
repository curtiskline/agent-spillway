# ADR 0010: Finish onboarding tooling before wider automation

Status: accepted, 2026-10-13, following owner-authorized PR #3 merge and continued implementation.

Phase 3 has a tested execution/evidence pipeline but lacks a single operational diagnostic and the specification's versioned public pilot tasks. Add these before new hardware concurrency, scheduled drains or automatic limit work.

Keep readiness logic inside the service. A closed diagnostic report uses validated config, exact harness version, local catalog presence and operational/evidence snapshots. It never runs inference or repairs configuration, and warnings cannot certify capability. Hosted/frontier catalogs are skipped to avoid new external calls. The CLI reports an unavailable service with fixed setup guidance.

Materialize original Apache-2.0 fixtures into a new disposable repository, with pinned task files and manifest beside it outside existing Git. Refuse existing destinations; do not modify configuration, bank work or accept outcomes. Three disjoint tasks exercise two local classes and a frontier hold. Protected independent checks distinguish baseline and representative bad implementations from correct work. This pilot set is tuning evidence, separate from held-out tasks and fixed qualification workloads.

Measure static plugin file/descriptor byte counts before release without pretending they are tokenizer measurements or total session context. No new dependency, database migration, inference loop, owner decision, public profile or release is introduced. Actual owner/session/hardware outcomes remain separate gates.
