# Rainbird for VSCode — Feature ideas beyond the current prototype

*Prepared 2026-09-03 from four inputs: the prototype source (v0.0.2), [PROPOSAL.md](PROPOSAL.md) plus the [research corpus](research/), a fresh survey of docs.rainbird.ai, the live OpenAPI spec and Rainbird Labs, and a survey of ~40 comparable VSCode extensions (rules and policy engines, logic languages, schema DSLs, API clients, AI tooling).*

## How to read this

- **Surface** (same legend as the proposal): 🟢 client-only · 🔵 documented public API · 🟠 undocumented API (pre-release ring) · 🔴 needs new platform work
- **Status**: **DEEPEN** = exists in the prototype but has a real gap · **PLANNED** = in PROPOSAL.md, not built · **NEW** = not in the proposal
- **Effort**: S (days) · M (2–4 weeks) · L (a quarter or more), assuming today's regex index unless marked *needs parser*

## 1. Recommended build order

| # | Feature | Why it matters | Surface | Status | Effort |
|---|---|---|---|---|---|
| 1 | Query panel completeness: grouped questions, undo, inject fixtures, version picker, object and first-form queries, multi-query sessions | Grouped questions (`extraQuestions[]`) are only counted today, so the panel stalls on any map that uses question groups | 🔵 | DEEPEN | S–M |
| 2 | Static analysis pack: reachability ("this condition can never be satisfied"), rule cycles, evaluation-order hints, date/regex/quote checks, evidence-text variable checks | "No result" is the top troubleshooting topic in Rainbird's docs and Studio catches none of these | 🟢 | NEW | M |
| 3 | Evidence → source navigation and fired-rule decorations in the editor | The evidence tree is Rainbird's differentiator; today it only overlays the graph view | 🔵 | PLANNED / DEEPEN | M |
| 4 | Draft-vs-Live promotion diff (one scenario, two sessions, diff of results and evidence) | The question every compliance owner asks before Set Live; Studio has no diff at all | 🔵 | NEW | M |
| 5 | Rename cascade fix, then formatter and "Organize Map" | Rename misses expression strings, evidence text and datasource maps; Studio has propagated renames since 4.88 | 🟢 | DEEPEN / PLANNED | S–M |
| 6 | Plain-English rule rendering feeding hovers, semantic diff, a spec generator and a traceability matrix | The SME sign-off artifact; the bundled sample map already carries spec IDs in rule names | 🟢 | NEW | M |
| 7 | Test runner with Studio semantics plus rule coverage | Question-order and no-result expectations, results-only mode, version pins, Studio JSON import; coverage painted from evidence trees | 🔵 | DEEPEN | M |
| 8 | Evidence archive and Studio deep links | Sessions go read-only after 24 h and are purged after 7 days (Community) or 30 days (Enterprise); auditors need the tree after that | 🔵 | NEW | S |
| 9 | Datasource playground | Datasource authoring (CDATA bodies, response path maps) is a documented pain point with zero tooling anywhere | 🟢 / 🔵 | NEW | M |
| 10 | Copilot language-model tools, an MCP definition provider, and an agent-instructions generator | Gives Copilot and Cursor agents the same lint/query/test tools the built-in assistant has; matches Rainbird's agent-first positioning | 🔵 / 🟠 | PLANNED / NEW | M |
| 11 | QuickDiff against the last pushed snapshot | Cheap, always-on answer to "does my buffer match what is on the platform?" | 🟢 | NEW | S |
| 12 | Session facts inspector | "What does the engine know right now" while a query is running | 🔵 | NEW | S |

The rest of this document details these and the longer tail, grouped by theme.

## 2. Close the gaps in what already exists (DEEPEN)

**2.1 Grouped questions.** Relationships can carry `group="…"`, and the engine then returns one `question` plus `extraQuestions[]` in a single response. The panel shows "+N related questions queued" and only answers the first, so the loop desynchronises. Render the whole group as one card set and send all answers in one `/response` call. The assistant's `run_query` tool has the same blind spot. 🔵 S

**2.2 Undo.** `POST /{sid}/undo` is documented and is the "Back" button in Rainbird's published agents. One button on the question card. 🔵 S

**2.3 Inject before query.** The API client already chunks injects at the 250-fact cap, but no UI exposes it. Add a facts pane (paste JSON or CSV, or pick a `*.facts.json` fixture) and a "Save as fixture" action. This also unlocks Studio's "results-only" test style (inject facts, expect results, no questions). 🔵 S–M

**2.4 All three query forms.** The panel accepts a relationship and an optional subject. Add the object so users can run subject queries ("who speaks French?") and first-form certainty queries ("does Julio speak French?"). 🔵 S

**2.5 Version picker.** `/start` takes `useDraft=true` or `version=N`, and `/analysis/session?filter=version` already tells the panel which version a session hit. Surface a draft / live / version-N picker in the panel and per test file, and stamp `kmVersion.id` on every result and saved test. 🔵 S

**2.6 Rename cascade.** Rename edits only tag attributes (`kindOf` in [languageFeatures.ts](prototype/src/languageFeatures.ts)). It does not touch quoted relationship names inside list functions (`countRelationshipInstances(%S, 'lives in', *)`), dot traversals in evidence text (`{{%COUNTRY.national language}}`), datasource `action map="rel=/path"`, or `input rel=`. A rename today silently breaks the map. Extend the span collection to those four sites. 🟢 S–M

**2.7 Richer question cards.** Date picker for `date` answers, numeric validation, markdown rendering of prompts (Studio allows markdown in question text), `knownAnswers` shown, `canAdd` honoured per side. 🔵 S

**2.8 Multi-query and attach.** Studio's Quick Query lets you reuse a session across several queries. Add "Ask another question in this session" and "Attach to session ID" (the integrator design's session runner, with its "continue, not replay" caveat). 🔵 S–M

**2.9 Session facts inspector.** `GET /analysis/session/{sid}?filter=facts` returns global, local and context facts with their source. Show them as an auto-refreshing tree beside the query panel, the way the CLIPS extension shows its live facts and agenda. 🔵 S

**2.9b Platform pull (done 2026-09-03).** `GET /analysis/file/{kmID}` gives the draft's RBLang and `?version=N` any saved version, so the Maps view opens the real draft, the query panel can list goals without an open file, and the draft-vs-saved-version diff runs on the API. 🔵 S

**2.10 Evidence to source.** The evidence payload has no rule name (platform ask #5), but it carries the relationship type, condition triples and the rendered `alt` text. Compile each rule's `alt` template into a regex, match it against the evidence node's text, fall back to relationship-plus-condition fingerprinting, and offer a QuickPick on ambiguity. Then paint fired rules in the editor gutter with their certainty, the way Regal renders evaluation results inline and OPA paints coverage. 🔵 M

**2.11 Studio deep links.** The evidence URL format is documented: `[STUDIO]/evidence?id=[FACT_ID]&api=[API_HOST]&sid=[SESSION_ID]`. Add "Open in Studio" and "Copy evidence link for SME" to every result card. 🔵 S

**2.12 Test runner with Studio semantics.** Studio's automated tests fail on an unexpected question, a wrong question order, an unexpected result, or a "No result" expectation, and support a results-only mode via inject. Mirror all of that in `.rbtest.json`, pin tests to a version, confirm before large runs (result-returning queries are billable), and import or export Studio's test JSON once a real export is available to infer the schema (ask #2). 🔵 M

**2.13 JSON schemas for sidecar files.** Contribute `jsonValidation` schemas for `.rbtest.json` and `.facts.json` so they get completions and validation. 🟢 S

**2.14 Datasources and imports in the views.** Both appear in the outline but not in the Map Explorer or the graph. 🟢 S

## 3. Static analysis Studio cannot do (NEW, all 🟢)

These are the highest-leverage additions because they need no platform calls and no billing, and because Rainbird's own troubleshooting page still advises "split the rule and make every condition optional, then read the evidence tree".

**3.1 Reachability analysis.** For every relationship used as a goal or condition, decide whether the engine can ever satisfy it: it has facts, or rules that infer it, or it is askable, or its subject concept has a datasource. Report "condition on X can never be satisfied" and "rule Y can never fire" as warnings, and "goal Z will always return no result" on the CodeLens. M

**3.2 Rule cycle detection.** A relationship that infers itself through a chain of rules is legal but is the usual cause of query-depth blow-ups (the limit is 2,000,000). Warn with the cycle path. S–M

**3.3 Evaluation-order hints.** Expressions evaluate strictly left to right, with no precedence. Show the effective bracketing as an inlay hint or hover (`%A + %B * 2` → `((%A + %B) * 2)`) and offer a quick fix that inserts explicit parentheses when operators are mixed. S

**3.4 More expression checks.** Date values compared with `>` or `<` instead of `isBeforeDate` and friends; double quotes inside an expression (a validation error since 4.98); `regexCount` patterns compiled with the JS `RegExp` constructor to validate syntax and flags; `minimum-rule-certainty` greater than `cf`; string literals that match no declared instance when the concept has instances. S each

**3.5 Evidence-text checks.** `{{%VAR}}` in `alt` that no condition binds; `{{%VAR.rel}}` where the relationship is undeclared or its subject type does not match the variable's concept. S

**3.6 Modelling checks.** Askable relationships with no question forms; mutually-exclusive concepts with rules that can produce both instances; instances declared but never used; a non-plural relationship with several facts for the same subject. S each

**3.7 Relationship call hierarchy.** Register a Call Hierarchy provider: incoming calls are the rules that infer a relationship, outgoing calls are the relationships a rule depends on. VSCode's peek and tree UI comes for free. Add a "rule dependency" mode to the graph view (relationships as nodes, rule edges), which is a different picture from today's concept schema. M

**3.8 Plain-English rule rendering.** Deterministic, no LLM: "IF %S lives in COUNTRY (mandatory, 100) AND COUNTRY has national language %O (mandatory, 100) THEN %S speaks %O, at most 75%". Use it in hovers and CodeLens, in the semantic diff instead of raw condition strings, in the spec generator (section 4.7), and as grounding for the assistant. S–M

**3.9 Single-rule certainty calculator.** The per-rule arithmetic is documented: impact = weight × fact certainty, impacts sum, capped by `cf`, floored by minimum rule certainty. A hover table or a small slider panel lets an author tune weights without spending queries. Stop at one rule: how several rules combine for the same fact is not documented. S–M

**3.10 Expression scratchpad.** An offline evaluator for the 51 functions with left-to-right semantics and sample variable values, in the spirit of Regal's "Evaluate" lens but client-side. Label the output as an approximation and offer "verify on platform" when connected. M–L

**3.11 Boundary-value test suggestions.** Parse numeric and date comparisons (`%AGE >= 18`) and propose cases at 17, 18 and 19; one click runs them and saves the survivors as `.rbtest.json`. M

**3.12 Question-flow preview.** For a goal, list the questions the engine may ask, in probable order (respecting top-down behaviour), with `%S`/`%O` substituted and markdown rendered. Lets authors design the interview without billing. Approximate; label it. M

## 4. Authoring productivity

**4.1 Formatter and Organize Map.** Format-on-save with the docs' recommended order (concepts → relationships → instances → facts → rules), stable attribute order, two-space indent. Load-bearing for clean PR diffs. PLANNED 🟢 M *needs parser for comment preservation*

**4.2 Bulk generators.** CSV → instances, CSV → facts, paste-a-list → instances. These were the abandoned incumbent extension's most-used commands. PLANNED 🟢 S

**4.3 Facts table editor.** Show every fact of a relationship as an editable grid (webview or optional custom editor, like the Salesforce SOQL builder that round-trips with text). Subject-matter experts think in tables, not XML. NEW 🟢 M

**4.4 Semantic tokens and inlay hints.** Colour each `%VARIABLE` consistently within a rule (the "rainbow predicates" pattern from ASP tooling), highlight all occurrences of a variable, show concept types next to `subject`/`object`, and label each `relinst` as fact or rule. Signature help for expression functions. NEW 🟢 S–M

**4.5 Refactorings.** "Extract intermediate relationship" (split a long rule, the docs' own debugging advice), "Name unnamed rules" (from `alt` text or AI), "Add question forms to askable relationships" (templated), "Convert fact block to CSV and back". NEW 🟢 M

**4.6 Traceability matrix.** Rule names in the sample map already carry spec IDs ("RF-4.2"). Recognise `@req` comments or name prefixes and render a requirement ↔ rules ↔ tests matrix, exportable as markdown for auditors. NEW 🟢 M

**4.7 Decision model spec generator.** One command produces a markdown or HTML document: concepts, relationships with their question wording, rules in plain English with weights, datasources with endpoints. This is the artifact an SME signs off and the thing Studio's "Version Preview" cannot produce. NEW 🟢 M

**4.8 Docs integration.** Hover links to the matching docs.rainbird.ai `.md` page per element and function; an "Ask the Rainbird docs" command backed by the docs site's `?ask=` endpoint; a `search_docs` tool for the assistant. PLANNED 🟢 S

**4.9 Paste transforms.** Pasting Studio code-panel XML or a JSON fact array converts and formats it (the Bicep "paste as" pattern). NEW 🟢 S

**4.10 `.rbird` preview editor.** Open a `.rbird` directly: read-only view of its RBLang, README and layout summary, with an "Extract" button, and a layout sidecar that the graph view can use for Studio-faithful positions. PLANNED 🟢 M

**4.11 Multi-file maps.** Split a large map into `.rbl` parts assembled by a build manifest for push; workspace-wide symbols, references and diagnostics; resolution of `<import km versionNumber>` against sibling files. The 4,491-line sample map is the motivation. PLANNED 🟢 L *needs parser*

**4.12 Workspace symbols.** Cmd+T search across every map in the workspace, matching Studio's Navigator. NEW 🟢 S

## 5. Testing, governance and ModelOps

**5.1 Promotion diff.** Run one scenario or a whole suite against draft and live (or version N) in parallel and diff results and evidence trees: "rule X's weight change moved the outcome from 82% to 61%". This is the public-API half of the proposal's Phase 3 "evidence regression diff" and the concrete software behind the ModelOps marketing line. NEW 🔵 M

**5.2 Rule coverage.** After a test run, walk the evidence trees, map fired rules to source (2.10) and feed VSCode's Test Coverage API so untested rules show in the gutter and in the coverage view, as Logtalk and OPA do. NEW 🔵 M–L

**5.3 Replay a production session as a test.** `GET /analysis/interactions/{sid}` (recording must be on) gives the full question and answer sequence; convert it to `.rbtest.json`. Also the basis for support-ticket forensics. PLANNED 🔵 M

**5.4 Evidence archive.** Sessions become read-only 24 hours after the last update and are purged after 7 or 30 days. "Archive decision" writes the evidence JSON, rendered tree, NL explanation and `kmVersion.id` into the workspace or a zip before they vanish. NEW 🔵 S–M

**5.5 QuickDiff against the pushed snapshot.** The extension already snapshots the exact RBLang sent on every push. Register an SCM quick-diff provider over that snapshot so gutter bars show what has changed locally since the last push. NEW 🟢 S

**5.6 Review comments.** Use the Comments API for inline review threads on rules, persisted to a git-tracked sidecar. Studio has no commenting and no roles documentation. NEW 🟢 M

**5.7 Headless CLI and CI scaffold.** `npx` lint, test and diff sharing the extension core; a GitHub Action template; SARIF for lint and JUnit for tests. PLANNED 🟢 / 🔵 M–L

**5.8 Query budget.** Status-bar counter of result-returning queries per session and per day, with a confirmation before large runs. PLANNED 🔵 S

**5.9 Environment aliasing.** A `.rainbird.json` that maps a logical map name to a kmID per environment, so the same suite runs against dev, test and prod. Pair it with a promotion checklist that reflects the documented path (export `.rbird`, import into the target to preserve the KMID, re-run tests because tests are not in the export). PLANNED 🟢 S–M

**5.10 Engine-version compatibility lint.** A feature-to-minimum-version table probed against `GET /version`; doubles as the changelog Rainbird stopped publishing at 4.106. PLANNED 🔵 M

## 6. Debugging

**6.1 "Why no result?" analyzer.** On an empty result, combine the static reachability report (3.1) with session facts and the case-sensitivity and unknown-instance footguns ("accepted silently and attach to nothing") into one ranked explanation. NEW 🔵 M

**6.2 Datasource playground.** Run a datasource's HTTP request from the editor with a sample `%S` and input values, show the response, click JSON paths to generate `<action map>` entries, and lint existing maps against the last real response. NEW 🟢 / 🔵 M

**6.3 Rule Tracker bridge.** Rainbird Labs ships a Rule Tracker (rule-execution tree in interactive, live-draft and recorded-session modes, JSON export). Deep-link to it with kmID and session prefilled now; consider an in-editor equivalent later. NEW 🔵 S

**6.4 Question-loop debugger.** A DAP adapter where each question is a stopped event, session facts are Variables, and step-back calls `/undo`. Never marketed as rule breakpoints, which need an engine trace API (ask #9). PLANNED 🔵 L

## 7. Integrators

**7.1 Copy as code.** From any query transcript: curl, TypeScript SDK, Node fetch, Go, and the Power Automate connector's JSON shape, with the known traps baked in (the SDK's `cf` versus REST's `certainty`, the `Version: v1` header on NL calls). PLANNED 🟢 S–M

**7.2 `.rbreq` request files.** Git-diffable decision requests with a run CodeLens and a status-bar environment switcher, the REST Client pattern. PLANNED 🔵 M

**7.3 Capability explorer.** "API docs for this decision service" generated from the local map: queryable relationships, askable versus inject-only, question wording, types; export to markdown. PLANNED 🟢 S–M

**7.4 Interaction timeline.** Viewer for `/analysis/interactions` with CSV and JSON export and the "recording is off by default" education front and centre. PLANNED 🔵 S–M

**7.5 Payload linting.** Validate `.facts.json` and inject payloads against the map: unknown or case-mismatched instance names, batches over 250, forbidden characters, `cf` versus `certainty`. PLANNED 🟢 S–M

**7.6 Typed client generation.** One function per queryable relationship, a question-callback interface, and drift detection through the `kmVersion.id` every `/start` returns. PLANNED 🟢 L

## 8. AI and agents

**8.1 Language-model tools.** Contribute `rainbird_lint_map`, `rainbird_run_query`, `rainbird_get_evidence`, `rainbird_run_tests` and a confirmation-gated `rainbird_push_map` through `languageModelTools`, so Copilot agent mode and Cursor get the tools the built-in assistant already has. The TLA+ and Prisma extensions ship this pattern. PLANNED 🔵 M

**8.2 MCP definition provider.** Replace writing `.vscode/mcp.json` with an `McpServerDefinitionProvider` that resolves the served-graph URL from SecretStorage, so the self-authenticating URL never lands on disk. Also expose the extension's own lint, query and test tools as an MCP server for external agents such as Claude Code. PLANNED / NEW 🟠 M

**8.3 Agent-instructions generator.** Emit `AGENTS.md`, `CLAUDE.md` or `.github/copilot-instructions.md` from the schema table: RBLang rules, the left-to-right footgun, the lint and test commands. Any coding agent in the repo then writes valid RBLang, which is the premise of Rainbird's own Claude Skill. NEW 🟢 S

**8.4 Model provider choice.** Let the assistant run on the VSCode Language Model API (a Copilot subscription, no key) or on AWS Bedrock, which mirrors Rainbird's own EU-Bedrock choice for Co-author and matters to regulated customers. NEW 🟢 M

**8.5 Assistant tool upgrades.** Add `search_docs`, `get_evidence`, `run_tests`, `semantic_diff` and workspace map reading; include the docs' 20-point validation checklist and the plain-English renderer output in the system prompt. Fix `run_query` to handle grouped questions. NEW 🔵 S–M

**8.6 AI bulk codemods with preview.** Generate question wording for askable relationships, evidence text for rules, and names for unnamed rules, each presented as a refactor preview before applying. NEW 🟢 M

**8.7 Generate from documents and Consult-style interviews.** Drop a PDF, CSV or text file and get a draft map; or let the assistant interview the expert. Co-author remains the sanctioned path for sensitive documents, and the UI should say so. NEW 🟢 M

## 9. Exploration and onboarding

**9.1 Decision notebook.** `%start`, `%inject`, `%query`, `%answer`, `%undo` and NL cells with an evidence renderer and "Save session as test". Must handle grouped questions. PLANNED 🔵 L

**9.2 Zero-account first run.** Prefill the docs-published HelloWorld sandbox in the walkthrough so the first decision runs in under a minute. PLANNED 🔵 S

**9.3 Web build and Open VSX.** Language features on vscode.dev and github.dev for PR review (API calls blocked until CORS, ask #7); Open VSX publishing for Cursor and VSCodium users. PLANNED 🟢 M / S

## 10. What stays blocked, and why

- **Package as `.rbird`**: Studio's importer trusts the structured model arrays, not the RBLang lines. Needs the full parser plus a live round-trip test.
- **Maps sidebar with list, create-version and set-live**: no management API (`GET /maps` returns 404). Ask #8. *Update 2026-09-03:* **pull is possible** — `GET /analysis/file/{kmID}[?version=N]` (undocumented, verified live) returns a map's RBLang plus Studio's structured `concepts`/`rels` arrays for the draft or any version. Built into the extension the same day (pull, draft-vs-version diff, local-vs-draft diff). Those structured arrays may also be what a faithful `.rbird` repack needs.
- **True rule-level stepping**: needs an engine trace API. Ask #9.
- **Exact evidence-to-rule matching**: needs a rule identifier in evidence responses. Ask #5. Section 2.10 is the heuristic bridge.

## 11. Platform facts from this pass that shape the roadmap

- Data retention defaults are 7 days on Community and 30 on Enterprise, and sessions are read-only 24 hours after the last update. Anything forensic must copy data out early.
- Studio has no version diff; Version Preview is read-only and the docs suggest exporting and diffing externally. The semantic diff is the only diff Rainbird users have.
- Renamed relationships propagate into expressions in Studio since 4.88, so the extension's rename must match.
- Question groups exist (`group` attribute) and arrive as `extraQuestions[]`.
- The expression language has no NOT operator; absence is tested with `countRelationshipInstances(...) is equal to 0`.
- Rainbird Labs runs a Rule Tracker at tracker.labs.rainbird.ai with interactive, live-draft and recorded-session modes.
- A Microsoft Power Automate connector and a UiPath activity exist; integrators on those stacks are a real audience for copy-as-payload.
- The public changelog still ends at 4.106 while the engine reports 4.118; no MCP documentation exists on docs.rainbird.ai and the marketed `mcp.rainbird.ai` host did not resolve on 2026-09-03.
