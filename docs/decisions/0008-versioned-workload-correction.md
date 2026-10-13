# ADR 0008: Version a qualification instruction correction

Status: accepted, 2026-10-12.

The first full-GPU real v1 run completed all seven protected code checks, but discovery failed its observed-tool gate: the model used glob `**/*`, while the observer required `docs/**`. The v1 instruction requested glob discovery without specifying that pattern. This is an instruction/grader mismatch and cannot support a general discovery-incapability claim. Recovery masked the required exit 17 and multi-round omitted grep; those are separate unmet explicit requirements.

Keep v1 assets, hashes and stored outcomes immutable. Introduce default workload v2, changing only the discovery instruction to disclose the exact existing pattern. Preserve all observer predicates, protected assets, seven cases, time/attempt budgets and qualification gates. Do not regrade the existing result or promote classes.

The private result format remains version 1; its suiteVersion is 1 or 2. Strict result validators support both so old jobs remain inspectable, and new content hashes bind the revised workload. Unsupported suite versions fail closed. No database migration or API/MCP shape change is required.

Verification includes the exact v2 instruction, identical remaining cases/assets, historical result inspection, unsupported-version rejection, real Git fixture execution and package inclusion of both workloads. A subsequent real v2 run is separate evidence, never a relabeled v1 run. Publication and release remain owner decisions.
