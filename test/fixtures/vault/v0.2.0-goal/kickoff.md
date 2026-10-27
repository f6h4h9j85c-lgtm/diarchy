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

- AC1: Requests over the per-key limit get HTTP 429 with a Retry-After header
- AC2: The README documents the per-key limit
