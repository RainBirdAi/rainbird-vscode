# Changelog

## Unreleased

- **Query panel**: grouped questions (`extraQuestions`) are now shown together and answered in one call — previously only the first question of a group was answered and the session desynchronised. Added **↶ Back** (`POST /undo`), a **facts-to-inject** box (JSON or CSV, or load a fixture file), a **draft / live / version** target picker, and an optional **object** so subject queries and first-form certainty queries work. When a map has no live version the engine silently serves the draft; the panel and the promotion diff now say so. Saved tests record the target and injected facts and replay them.
- **Promotion diff** (`Rainbird: Compare Versions…`, also “Compare with another version…” on a result): replays a saved test or the last panel session against two versions of the same map (draft vs live by default) and reports result and certainty changes plus, when evidence is accessible, the facts, rule conditions and impacts that moved.
- **Platform as a source of RBLang.** `GET /analysis/file/{kmID}[?version=N]` (verified live; not in the public spec) returns a map's RBLang for the draft or any saved version. Built on it: **`Rainbird: Compare Draft vs Saved Version…`** (platform draft vs latest / live / numbered version, or against a Studio `.rbird` export or the open `.rbl`, with a semantic report and an optional side-by-side text diff; also on right-click of a `.rbird`); **`Rainbird: Pull Map RBLang from Platform…`** (read-only view of the draft or a version, with Save As); **`Rainbird: Diff Open File Against Platform Draft`** (the honest “am I in sync?” check); the **Maps view** now opens the real platform draft instead of a push snapshot; the **query panel** lists goals from the platform draft when no `.rbl` is open. The plain semantic diff’s base picker accepts `.rbird` exports too.
- **Semantic diff** now pairs rules that were renamed or newly named (instead of reporting a removal plus an addition) and describes condition weight / mandatory changes on the same condition instead of listing it twice.
- **Quick diff against the pushed snapshot**: gutter change bars and `Rainbird: Diff Against Last Pushed Snapshot` compare the local buffer with exactly what was last pushed from VSCode.
- **Rename now cascades** into quoted relationship/instance names inside expressions (list functions), `{{%VAR.relationship}}` traversals in evidence text and datasource `action map=` targets — Studio has propagated renames into expressions since 4.88, and a rename that missed them silently broke the map.
- **New diagnostics**: left-to-right evaluation warning with two quick fixes (keep the engine’s order / use conventional precedence) and an inlay hint showing how the engine reads the expression; reachability (“can only be satisfied by injected facts” on relationships, “this rule can never fire” on rules) in conversational maps; recursive-rule hints with the cycle path.
- **AI assistant** `run_query` tool handles grouped questions and accepts `object` and `version`.

## 0.0.2 — 2026-09-02

- Quick fixes (💡) on diagnostics: declare missing instances, did-you-mean renames for typo'd references, valid enum value picks, add missing / remove unrecognised attributes, delete duplicate declarations and facts.
- Outline view, breadcrumbs and sticky scroll (document symbols), plus structure-based folding for elements and comment blocks.

## 0.0.1 — 2026-09-02

Initial test release.

- RBLang language support (`.rbl`, `.rblang`): TextMate grammar, diagnostics, completions, hovers, snippets, go-to-definition/references/rename, CodeLens.
- Interactive query panel with question cards, certainty bars and inline evidence trees; graph view with evidence overlay.
- AI assistant sidebar (bring your own Anthropic API key) with lint/query/push tools.
- Push maps to the Rainbird platform, per-environment map registry, natural-language querying (beta), semantic diff, `.rbird` extraction, MCP server registration, regression tests, Getting Started walkthrough.
