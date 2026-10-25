---
protocol_version: 1
goal: 20261025-rate-limit
lead: claude
challenger: codex
agents: [claude, codex]
budgets: {}
project: /home/user/api
vault: /home/user/api/api brain/diarchy
created: 2026-10-25T14:00:00Z
by: human
---
Add per-API-key rate limiting to the public API.

- AC1: Requests over the per-key limit get HTTP 429 with a Retry-After header, and the count is shared across all API replicas.
- AC2: The limit is configurable through RATE_LIMIT_PER_MIN with a documented default.
- AC3: Tests cover the 429 path and the config override, and the full suite is green on main.
