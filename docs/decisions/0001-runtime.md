# 0001: TypeScript and Node SQLite

Accepted 2026-10-12. Use TypeScript ESM and Node >=22.13 built-in SQLite, with npm distribution. This follows the primary specification's recommendation, integrates the MCP SDK, and keeps state in a single local process without a native SQLite package installation step. `node:sqlite` may emit an experimental warning on older supported runtimes; CI must test Node 22/24. The small synchronous database is sufficient for one slot. Revisit only with measured bottlenecks or runtime incompatibility.
