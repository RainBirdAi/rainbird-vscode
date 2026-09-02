# Research: Rainbird MCP research preview (first-party source, 2026-09)

Source: an internal/preview Rainbird document describing "Test this graph over MCP" (provided by the user, who works at Rainbird). Treat as CONFIRMED current preview capability, not speculation. Do NOT reproduce any concrete endpoint URL/ID — they are self-authenticating secrets.

## Mechanics

- Every published graph (project) can be served as a Model Context Protocol endpoint at `https://rake.rainbird.ai/mcp/graph/<GRAPH_ID>` — Streamable HTTP transport, NO auth headers; the URL itself grants access ("treat this URL like a password").
- The endpoint belongs to the project: it keeps the same URL across rebuilds and always serves the project's current version. It can be paused/removed from the dashboard ("Served graphs" table toggle, or delete the project), which instantly cuts access.
- Works in any MCP client: Claude Code (`claude mcp add --transport http <name> <url>`), Claude Desktop / claude.ai custom connectors, or any Streamable-HTTP MCP client config.

## Tools exposed per graph endpoint

- `describe_graph` — lists the kinds of query the graph can answer and the inputs each needs (describes how to query, not internal rules).
- `inject` — assert facts before asking ({subject, relationship, object}); returns a `session` to reuse with `query`.
- `query` — ask a goal. Args: `goal` (a relationship), optional `subject`, optional `facts` (injected first), optional `session`. Returns the answer or the follow-up questions the graph needs.
- `answer` — supply facts for a graph question and continue. Args: `session`, `facts`.
- `explain` — show how a specific result was reached from its full evidence (derivation) tree. Args: `session`, result item's `factId`. Requires the graph's "Evidence Tree Link" toggle to be ON (Studio → Publish → Live Version → API Management → Access Control); otherwise errors while the other four tools still work.

## Notable UX details (useful design signals)

- The generated doc for each served graph enumerates every queryable relationship with subject/answers concept types, example subjects, plus "key concepts" glossary — i.e. the platform can already generate a per-graph capability manifest.
- Askable vs inject-only facts are distinguished; unknown answers are permitted per-fact; unrecognized instance names are "accepted silently and attach to nothing" (a footgun the doc warns about — an extension linter/test harness could catch this).
- Sessions carry across inject → query → answer chains.
- This all lives under the RAKE umbrella (rake.rainbird.ai) as a research preview.
