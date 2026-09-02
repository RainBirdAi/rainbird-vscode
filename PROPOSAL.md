# Rainbird for VSCode — Product Proposal

*Prepared 2026-09-01. Companion artifacts: a working [prototype](prototype/) (compiles, runs today) and the [research corpus](research/) behind every claim in this document.*

---

## 1. Executive summary

Rainbird's own developer page promises: *"All Rainbird knowledge graphs are written in Rainbird's readable XML format called RBLang. You can export, diff, review in a pull request, and regression test in your CI process."* The pricing page sells *"Graded evals in your CI"* and *"ModelOps: who changed what, when and why."*

**There is no software behind any of those sentences.** The only sanctioned RBLang editing surface is a legacy AngularJS Ace editor embedded in Studio as an iframe, whose autocomplete lags the shipped engine by eight expression functions. The only VSCode extension ever built for RBLang (`tom-sherman.rainbird-engineer-tools`, 455 installs) has been abandoned since June 2019 and contributes no language support at all — just XML snippets. There is no CLI, no formatter, no test runner, no presence on Open VSX (where Cursor and VSCodium users live). The field is completely open.

Meanwhile, the raw material for a first-class extension already exists: RBLang's full structural schema is extractable from Studio's own production bundle, the Decisions API is documented with an OpenAPI spec, `.rbird` exports are just gzipped JSON containing the RBLang source, and the RAKE preview already serves published graphs as MCP endpoints.

**The proposal:** one official `rainbird`-published VSCode extension whose strategic wedge is *text and git as the source of truth*, serving three audiences with layered features:

- **Customer knowledge authors** get the pro-code authoring surface Studio never had: a real language server, query running with evidence trees in the editor, regression tests, semantic diffs for SME sign-off.
- **Third-party integrators** get the missing developer console for the Decisions API: an interactive session runner, evidence forensics from production IDs, typed client generation, CI scaffolding, and one-command MCP registration into agent stacks.
- **Internal Rainbird engineers** get the accelerator production line (scaffold → lint → eval → CI), the dogfooding ring that hardens undocumented surfaces (`POST /maps`, MCP preview) into public contracts, and an engine-version compatibility database that becomes the changelog the company stopped publishing at v4.106.

Everything in the MVP runs against **today's documented public API or pure client-side code**. Undocumented surfaces are shipped behind a pre-release ring with honest labels; genuinely new platform work is collected into an explicit ask-list (§7) rather than faked.

---

## 2. Why now — the evidence

| Finding | Source |
|---|---|
| Marketing promises git/diff/PR/CI workflows with zero tooling behind them | rainbird.ai/developers, /pricing (verbatim quotes verified) |
| Studio's RBLang code panel is a legacy AngularJS Ace iframe (`legacy.app.rainbird.ai/editor`); its autocomplete is missing `includes`, `startsWith`, `endsWith`, `minObjects`, `maxObjects`, `isWithinRange`, `joinObjects`, `regexCount` | Studio production bundle inspection |
| The only prior extension is abandoned (2019), personal publisher, no grammar/language | Marketplace gallery API |
| Public changelog stopped at v4.106 (Mar 2026); the live engine reports v4.118 — 12 undocumented releases | docs changelog + `GET /version`, checked 2026-09-01 |
| The RBLang namespace URL `rbl.io/schema/RBLang` is domain-squatted (redirects to a shirt shop) | Direct TLS/redirect check |
| Rainbird's strategy is already agent-first: RAKE, the Claude Skill, MCP-served graphs, agent-optimized docs (llms.txt, `.md` mirrors, `?ask=` API) | docs.rainbird.ai, rainbird.ai/rake, MCP preview doc |
| Zero Rainbird/RBLang presence on Open VSX → Cursor/VSCodium/code-server users cannot install anything today | Open VSX API search |

The company's own AI-authoring investments (Co-author, RAKE, the Claude Skill) *increase* the need for this extension: agents generate RBLang as text, and text needs language tooling, validation, diffing, and CI — exactly what an IDE extension provides and Studio structurally cannot.

---

## 3. What ships, per audience

Features are labelled by **platform surface**:
🟢 `client-only` (no platform calls) · 🔵 `public-api` (documented today) · 🟠 `undocumented-api` (exists, unofficial — pre-release ring) · 🔴 `roadmap` (needs new platform work).

### 3.1 Customer knowledge authors (BDO/EY/DAC Beachcroft-style knowledge engineers)

**MVP**

1. 🟢 **RBLang language intelligence (LSP).** Diagnostics matching and exceeding Studio's validator + rblint (structural rules, reference checks, type agreement, expression validation against the 51-function catalogue, left-to-right/non-PEMDAS warnings, the `countRelationshipInstances(...) = 0` null-test idiom as a quick fix, variable-flow analysis, forbidden-character rules). Context-aware completions — including the 8 functions Studio's own panel is missing. Hovers linking to the docs' `.md` pages, go-to-definition, find-references, F2 rename with preview, outline. Zero config, ever: activates on `.rbl` files and sniffs pasted code-panel XML for `<rbl:kb`.
2. 🟢 **Canonical formatter** (format-on-save; two-space indent, recommended element ordering, stable attribute order). Load-bearing for clean PR diffs — and ironically the abandoned incumbent's marketplace category was "Formatters."
3. 🔵 **Run Query codelens.** The Regal "evaluate" pattern: a codelens on every `<rel>` and rule runs a live session (`/start?useDraft` → auto-inject a conventional `facts.json` → `/query` → interactive question loop honoring First/Second Form, `allowCF`, `allowUnknown`, grouped `extraQuestions` → inline result with certainty). *Post-review fixes:* an explicit kmID-pairing step (pasted once from the Publish page, remembered per file), the actual `kmVersion.id` from `/start` shown on every result, a persistent "ran against platform draft — local buffer may differ" indicator until Push exists, and a billable-query counter.
4. 🔵 **Evidence tree & salience inspector.** The flagship debugging surface: recursive `/analysis/evidence` walk rendered with Studio's source colour-coding, per-condition impact/salience bars, bindings, `wasMet`. Click a rule node → jump to its line in the source. *Post-review fix:* the evidence payload carries **no rule name**, so source matching uses relationship type + condition fingerprint, labelled heuristic, with a candidate QuickPick on ambiguity — and "add rule name to evidence responses" goes on the platform ask-list. Buttons: `/nl/explain` narrative, Studio deep link for SME sharing.
5. 🟢 **.rbird bridge.** Extract (gunzip → `.rbl` + layout sidecar + README) ships immediately — it's verified format v1.1 and the prototype already does it. *Post-review gate:* "Package as .rbird" is held until a live Studio import round-trip test confirms whether Studio re-parses the `rblang` lines or trusts the parallel structured model arrays (`unicronData.concepts/rels/...`); if the latter, repack must regenerate the full JSON model from the LSP's AST (effort M, not S). The documented KMID-preserving Studio re-import stays the governed path.
6. 🔵 **Decision test explorer.** `tests/*.rbtest.json` (Studio Automated Tests export format, adopted verbatim) in the native Test Explorer, run against draft or a pinned version, failures showing certainty diffs with one-click evidence. *Post-review fixes:* draft-sync state is a first-class UI element (warn/block when the local buffer differs from the platform draft), continuous-run-on-save is gated until Push exists, and a query-budget guard confirms before large runs.
7. 🟢 **Snippets & bulk authoring.** Full Studio-parity snippet catalogue (clean-room), plus the incumbent's proven generators: paste-a-list → `concinst`s, **CSV → facts**, new-map scaffold.
8. 🔵 **Zero-friction onboarding.** Connection manager (Community/Enterprise/private URL; keys in SecretStorage; status bar shows environment + live engine version) and a walkthrough whose first steps run against the docs-published HelloWorld sandbox — value before any account. *Launch dependency:* enable Evidence Tree Link on the sandbox map (one internal toggle) or the walkthrough's evidence step 403s; ship a canned fallback regardless.

**Phase 2**

9. 🟢 **Knowledge-map graph preview** (read-only webview; cytoscape.js — MIT, no watermark; Studio layout from the sidecar; click-through to source; SVG export for governance packs). Text stays the source of truth; graph *editing* is deliberately deferred (§6).
10. 🟢 **Semantic diff & PR review lens.** Model-level diff of two revisions ("Rule 'High risk counterparty': condition weight 100→60; added optional condition on 'sanctions list match'"), exportable as markdown for the PR body — the artifact that lets an SME approve without reading XML. Deterministic output shared with the CI runner.
11. 🟢 **@rainbird Copilot chat participant** (`/draft`, `/edit`, `/explain`, `/docs`): generation grounded in the open map's vocabulary, every block validated by the LSP before it's offered (the Noesis/Claude Skill self-correction loop, in-editor). Positioning: Co-author (Bedrock, EU, ISO 27001) stays the sanctioned path for sensitive documents; this uses the author's Copilot and says so in-product.
12. 🔵 **NL quick-query panel on `/nl/interact`** — the no-Copilot NL surface (challenge-pass addition): Studio's NL test agent in the editor, with the `unmatched`/`invalid` fact buckets surfaced as vocabulary-gap lint signals.
13. 🟠 **Push to platform** (`POST /maps` — verified contract: `X-API-Key` + `Version: v1`, body `{rblang, name, description}`). Honest create-only semantics: scratch graphs named `file@gitsha`, per-file kmID memory, server validation errors mapped back to editor lines, one-click fallback to the .rbird route. This is the feature that closes the draft-sync gap in 3 and 6 — promote it the moment it gets internal blessing.
14. 🟠 **Served-graph MCP integration** — see integrators (§3.2, item 7); authors use it to let agents probe their own models.

**Phase 3**

15. 🟢 **Workspace & linked-map intelligence.** Multi-map repos (the thing Studio structurally cannot do): workspace symbols, cross-map references, `<import km=... versionNumber=...>` resolution against sibling files (Studio-supported but undocumented — confirm ongoing engine support internally before promoting in UX).
16. 🔵 **Decision replay debugger (DAP)** — see §5; gated on a formal demand check, since the evidence inspector plus session-import-as-test may cover most of the need.
17. 🔴 **Maps & versions sidebar** (pull draft / push draft / create version / set live) — the headline roadmap ask; ships only when the management API exists (§7). No browser automation, no faking.

### 3.2 Third-party integrator developers

**MVP**

1. 🔵 **Environment & key manager** — multi-environment profiles (Community/Enterprise/SA/private/self-hosted), three key types (X-API-Key, x-evidence-key, x-interaction-key) in SecretStorage, status-bar environment + engine version. Connection test = keyless `/version` probe plus `401-vs-404` key check against a kmID.
2. 🔵 **Decision Session Runner** — a webview that drives and *teaches* the full session protocol: question cards rendered exactly from the wire schema, undo, an always-visible raw request/response log, 250-fact inject guard. Attach to an existing session by pasted sessionID (the sessionID is the credential — with a warning saying exactly that). *Post-review fix:* attach is "continue," not "replay" — history hydrates only from the interaction log when recording is on; otherwise show current fact state via `/analysis/session?filter=facts`; expired sessions get a clear 404 path.
3. 🔵 **`.rbreq` decision request files + run codelens** — a git-diffable JSON format for a decision run (environment *name*, never keys), JSON-schema validated, one codelens to execute; escape hatch into the Session Runner for unscripted questions; answers matched by triple, not array order.
4. 🔵 **Evidence Tree Inspector** — paste sessionID + factID from production logs → full recursive derivation tree, factID-prefix legend (WA:RF/KF/AF/IF), `/nl/explain` narratives, markdown/JSON export for audit tickets.
5. 🟢 **Copy-as-code + SDK snippets** — Session Runner recordings → TypeScript (`@rainbird/sdk`), Node fetch, Go, curl, with the trap knowledge baked in: the SDK's `cf` vs REST's `certainty`, the Go SDK's wrong enterprise URL, the `Version: v1` header on `/nl` calls.
6. 🔵 **Regression tests + CI scaffold** — `.rbtest.json` in the Test Explorer; version-pinned reproducible runs; "Record test from this session"; `Scaffold CI Workflow` emits a GitHub Action wired to the bundled headless runner (`npx`-able, same core as the editor).
7. 🟠 **MCP endpoint registration** — one command wires a served graph into VS Code (via `McpServerDefinitionProvider` resolving the URL from SecretStorage so it never touches a file), Claude Code, or Claude Desktop; the URL is treated as a password throughout (masked input, never logged; *prototype-verify* that VS Code's MCP UI doesn't display it, and avoid leaving it in shell history for the Claude Code path). Fix-it hint when `explain` fails because the graph's Evidence Tree Link is off.
8. 🔵 **Walkthrough**: install → real decision against the HelloWorld sandbox in under a minute → evidence → copy-as-code → record a test.

**Phase 2**

9. 🟢/🟠 **Graph Capability Explorer** — "API docs for your decision service": every queryable relationship with types, askable-vs-inject-only, question wording — from a local `.rbird` (client-only) or live `describe_graph` (preview).
10. 🟠 **Typed client generation** — Prisma's schema→client loop for decision services: one typed function per queryable relationship, question-callback interface, manifest lockfile for clean PR diffs, drift warning via the `kmVersion.id` every `/start` already returns.
11. 🔵 **NL endpoints playground** — tune conversational frontends with the extracted-triple/fact-bucket/token-meter inspector; session-lock badge for the one-active-query rule.
12. 🟢 **Integration diagnostics** — payload linting (`.rbreq`/`.rbtest`/facts files): >250-fact batches, illegal characters, `cf`/`certainty` misuse, missing `Version: v1`, and manifest-aware unknown-instance detection (the documented "accepted silently, attaches to nothing" footgun). *Post-review scope:* app-code scanning ships JS/TS-only, gated on an actual `@rainbird/sdk` import; Go scanning deferred.
13. 🔵 **Copilot agent tools** (`rainbird_run_decision`, `rainbird_get_evidence`, `rainbird_list_capabilities`) — the MCP-independent agent path against the documented API, with `prepareInvocation` confirmations naming environment/KM/fact-count (decisions are billable).
14. 🔵 **Interaction Timeline** — production session forensics from `/analysis/interactions` (the documented no-webhooks observability surface), with the recording-is-off-by-default education front and center.

**Phase 3**

15. 🔵 **Graded evals + audit artifact export** — `.rbeval.json` suites scoring across datasets (CSV → cases), certainty-drift scorecards against a committed baseline, JUnit/SARIF for CI, evidence-bundle zips for expert sign-off. Engine version stamped on every scorecard so drift is attributable across the changelog blackout. *Verify internally whether `useDraft` runs bill before making draft the default cost story.*

### 3.3 Internal Rainbird engineers (and Rainbird-the-company)

**MVP**

1. 🔵 **Eval & regression harness** — the accelerator production line: Test Explorer + identical-core headless CI runner. *Post-review fixes:* per-environment evidence/interaction keys captured alongside the API key (or evidence links degrade gracefully with the Studio-toggle message); kmID aliasing (logical name → per-environment ID) so a cloned Community accelerator repo runs its evals unmodified; "imports Studio test exports" rather than over-promising round-trip.
2. 🟢 **Accelerator workspace scaffold** — `map.rbl` + `evals/` + fixtures + README with requirement-to-rule traceability + CI workflow, one command. Makes the Community-tier "download the accelerator, run the evals locally" promise true (noting "locally" means from-your-machine against the API — there is no local engine).
3. 🟢 **Corpus lint + bulk codemods** — workspace-wide rblint-parity linting with SARIF output for PR annotations. *Post-review split:* lint + rename in MVP; codemods (e.g. `allowCf`→`allowCF`, legacy `askable` values) are warn-only until each target semantic is verified by live round-trip — a one-click fix that rewrites working maps on unverified semantics is worse than none. Combined effort is L, not M.
4. 🟢 **.rbird codec + git ergonomics** — extract/pack, read-only `.rbird` preview editor. *Post-review fix:* committed extracted `.rbl` text is the canonical reviewable artifact; `.gitattributes` textconv is a *local* convenience only (GitHub/GitLab PR views don't run textconv) and the setup command says so.
5. 🟠 **Map upload via `POST /maps`** — the Labs dogfood ring: deterministic naming (`file@gitsha`), server errors parsed into diagnostics, "Run evals against the new kmID" chaining. Gated `rainbird.labs.enableUpload`, default-on in pre-release, off in stable; hidden on non-Community bases until verified there. Daily internal use generates exactly the contract pressure that graduates this endpoint.

**Launch decisions (deliverables, not features)**

6. **Publisher identity:** domain-verified `rainbird` publisher (Entra ID federation — global PATs retire Dec 2026). Contact Tom Sherman (near-certainly ex-Rainbird) for a deprecation notice on the incumbent; absorb his 11 snippet prefixes for muscle-memory compatibility (MIT — retain his notice). One extension, never a pack.
7. **Open-source the language core** (`rblang-language-server`: LSP, grammar, machine-readable schema, lint rules, .rbird codec, eval-runner core; Apache-2.0), keeping the platform-connected shell proprietary. Makes "you can leave with your logic at any time" technically credible, fixes the squatted-namespace embarrassment by publishing the canonical schema at a Rainbird URL (the `xmlns` string itself cannot change — Studio requires it verbatim), and collapses today's four divergent validators (Studio, legacy rblint, Noesis prompts, Claude Skill checks) into one dependency all internal tools can share. Requires a real ownership commitment — Drools is the cautionary tale.
8. **Marketplace + Open VSX dual publishing with release rings** — pre-release = internal dogfood ring (Labs features), stable = public-api surface only. Open VSX is the primary channel for the Cursor-heavy audience RAKE targets (note: Claude Code is a CLI and doesn't consume VSCode extensions — Cursor is the real target there).

**Phase 2**

9. 🔵 **Engine-version compatibility lint** — a versioned feature database (RBLang surface → minimum engine version) in the OSS repo; diagnostics when a map uses features newer than the pinned target environment. The DB doubles as the de-facto changelog for 4.107+, and maintaining it forces changelog discipline back into the release process.
10. 🔵 **Session forensics** — paste a sessionID from a support ticket → interaction timeline + evidence tree + "Replay as eval" (session → committed regression scenario). Requires the customer's keys in the ticket — stated explicitly.
11. 🔵 **Decision playground notebook** (`.rbplay`) — `%start`/`%inject`/`%query`/`%answer`/`%undo` cells against the live engine, NL cells via `/nl/interact`, and the killer command: "Save session as eval." Must handle grouped questions (`extraQuestions[]`) or it stalls on real maps.
12. 🟠 **MCP served-graph dogfooding** — as §3.2 item 7, plus the companion lint for silent-unmatched instance names. *Prototype-verify where VS Code surfaces the URL (server list, output channels, error toasts) before trusting the secrecy story.*

**Phase 3**

13. 🔵/🟠 **Evidence regression diff** — same scenario, two targets, structurally diffed evidence trees ("which rule and which weight changed the outcome") — the concrete software behind the ModelOps pricing line and the engine team's release-qualification tool. *Post-review split:* version-vs-draft A/B is public-api (stable); `x-rainbird-engine` A/B is undocumented-api (pre-release ring), with the header enforced on every request of a session.
14. 🟠 **Agent-mode tools + Claude Skill distribution** — `rainbird_lint_map` / `rainbird_run_evals` / `rainbird_query_graph` / `rainbird_upload_map` (confirmation-gated): the Claude Skill's 1–2-hour upload-and-see loop collapsed into instant local validation. Publishing the Skill methodology outside the login-gated forum is a product decision, tracked separately.
15. 🔴 **Account maps sidebar with true draft round-trip** — the written specification for the management API ask; ships nothing until the endpoints exist.

---

## 4. Cross-cutting architecture decisions

1. **Own language id `rblang`** (canonical extension `.rbl`), not an XML injection — an owned id anchors the LSP, codelenses, tests and debugging, and avoids fighting Red Hat XML over a namespace whose schema URL Rainbird no longer controls. A cheap sniffer flips pasted code-panel XML (`<rbl:kb` in the first lines) to RBLang — with `onLanguage:xml` + `workspaceContains:**/*.rbird` added to activation events so the sniffer actually runs (challenge-pass fix). Dual grammar: XML-shaped host + an embedded expression grammar inside `expression="…"`/`value="…"` (51 functions, natural-language operators, `%VARS`).
2. **From-scratch TypeScript language server**, bundled in-process (Prisma's WASM performance lesson; Terraform's bundled-LS lesson), node + web-worker builds from day one. The extracted Studio artifacts (validator table, rblint checks, context completer, snippet catalogue, structural schema) are treated strictly as a **specification to reimplement, never code to copy** — legal sign-off recorded. Error messages use Studio's exact phrasing so authors see identical results in both tools. The parser is **trivia-preserving** (comments/formatting survive) from MVP — required later by the formatter, semantic diff, and any graph write-back.
3. **Text is the source of truth.** `.rbl` in git is canonical; `.rbird` is the Studio interchange format, bridged by the codec; the graph view is a preview panel (not a custom editor) precisely to dodge undo-granularity and echo-loop hazards until editing is justified.
4. **Zero config, offline-first.** No mandatory config file (the GraphQL/Apollo 3-star mistake); the optional `.rainbird.json` binds a folder to a kmID/environment *name* but never gates language features; keys and MCP URLs live only in SecretStorage. No subprocess sprawl (the Salesforce 2.5-star mistake): one extension, one bundled LS, pure-TS deps (pako, no native modules).
5. **Honest debugging ladder.** There is no local engine, so: MVP = evidence-tree post-mortem (Rainbird's actual differentiator); Phase 2 = DAP adapter over the *question loop* (questions as stopped events, session facts as Variables, real step-back via `POST /undo`) — never marketed as rule breakpoints; Phase 3/roadmap = true rule-level stepping, which requires an engine trace API and is impossible to fake client-side.
6. **AI build order: MCP registration first** (platform-served, zero server code), **LM tools second** (they need workspace/LSP access MCP can't provide), **chat participant last** (conversational sugar over the tools; Copilot-gated). Non-Copilot users always have a path: the `/nl/interact` panel and a docs `?ask=` command.
7. **Web build (vscode.dev/github.dev) as a Phase 3 target** kept cheap by MVP discipline — the reviewer persona ("press `.` on a PR") is exactly where the git wedge lives. Platform calls from the browser need CORS on api.rainbird.ai (ask-list).

## 5. Phased roadmap

| Phase | Contents | Platform dependency |
|---|---|---|
| **MVP** (~1–2 quarters, 2–3 engineers) | Language server + grammar + formatter + snippets; query codelens + evidence inspector; test explorer + CI runner; .rbird extract; connection manager + walkthrough; corpus lint; accelerator scaffold; MCP registration; publisher/OSS/Open VSX launch decisions | None — documented API + client-side only (MCP registration is preview-labelled) |
| **Phase 2** | Graph preview; semantic diff; chat participant + `/nl/interact` panel; push via `POST /maps` (pre-release ring); capability explorer + typed clients; interaction timeline; notebook; compat lint; DAP question-loop debugger; LM tools | `POST /maps` blessing; test-JSON schema publication; MCP docs |
| **Phase 3** | Graded evals + audit bundles; evidence regression diff; workspace/linked-map intelligence; web build; graph editing write-back (scope-constrained, product sign-off); maps sidebar; true rule debugger | Management API; CORS; engine trace API; evidence rule-name field |

The single most protected feature if MVP must be cut: **the test explorer + CI runner** — it *is* the wedge, and it's the marketing promise with the largest gap behind it.

## 6. What deliberately stays in Studio

Versioning administration and set-live, agent publishing, Co-author's EU-Bedrock generation for sensitive documents, stats/reporting, and casual visual editing. Graph *editing* in VSCode is Phase 3 at most, scope-constrained to node/edge creation + rename + layout (no rule-form editing), and contingent on explicit product sign-off — a second visual editor competing with Studio's core surface is a maintenance liability for an 18-person company and muddies the text-first wedge.

## 7. The platform ask-list (kept honest)

Each ask is individually shippable and unlocks named features:

1. **Stabilize + document `POST /maps`** — update-in-place draft semantics, structured validation errors with line info, documented auth scope. *(Unblocks: Push, agent push tool; closes the local-buffer-vs-remote-draft gap in query/test runs.)*
2. **Publish the Automated Tests JSON schema.** *(Hardens the test explorer + CI runner.)*
3. **Publish MCP endpoint docs + a stable auth story**; confirm whether classic Studio-published maps (not just RAKE projects) get served-graph endpoints. *(Graduates MCP features from "preview.")*
4. **Resume the public changelog** — or adopt the extension's compatibility DB as its replacement. *(The LSP's engine-parity promise depends on knowing what shipped in 4.107–4.118.)*
5. **Add a rule name/identifier to `/analysis/evidence` responses.** *(Cheap; turns evidence→source navigation and rule-coverage painting from heuristics into exact matches.)*
6. **Enable Evidence Tree Link on the HelloWorld sandbox** (one toggle). *(Unblocks the walkthrough's marquee step.)*
7. **CORS headers on api.rainbird.ai.** *(Unblocks web/vscode.dev connectivity.)*
8. **Read-only map-metadata + list + export endpoints.** *(Unlocks cross-account import resolution and the maps sidebar.)*
9. **Engine trace/step API** (plausibly via an `x-rainbird-engine` debug variant). *(Unlocks the true rule debugger.)*

## 8. Risks

- **Legal/licensing:** extracted Studio assets are publicly served but proprietary — reimplement-as-spec with recorded sign-off. The incumbent's MIT snippets can be absorbed with attribution.
- **Engine drift:** the changelog blackout means the LSP's spec baseline needs live verification (round-trips via Studio paste or `POST /maps` in the internal ring) and the compat DB needs platform-team input — wrong data is worse than none.
- **Undocumented surfaces churn:** `POST /maps` and the MCP preview can change without notice — hence the pre-release ring, capability detection, and honest labels rather than silent breakage.
- **Secrecy of MCP URLs:** self-authenticating URLs must never reach settings files, logs, terminals, or VS Code's MCP UI unverified — prototype-verify the display surfaces.
- **Maintenance commitment:** an 18-person company shipping an OSS language server must own it (Drools died half-committed). Mitigation: the MVP is deliberately platform-independent, the LS doubles as internal shared infrastructure, and the extension replaces four divergent validators rather than adding a fifth.
- **Billing surprises:** result-returning queries are the billable unit — every runner (codelens, tests, evals, agents) carries counters and confirmation guards.

## 9. The prototype (built, working)

[`prototype/`](prototype/) compiles under strict TypeScript and runs with F5 today:

- Full **RBLang TextMate grammar** (elements, attributes, enums, embedded expression language with all 51 functions, `alt` interpolation, question-text placeholders) — built from Studio's validator table and real exported maps.
- **Diagnostics** (structural + referential + semantic footguns), **context-aware completions** (element/attribute/enum/map-local names/expression functions), **hovers**, and the full **snippet catalogue**.
- **Interactive query runner** against the real Decisions API (goal picker from the open map, full Match→Infer→Ask loop, results with certainty).
- **Evidence-tree webview** with recursive expansion and the documented source colour-coding.
- **Connection manager** (environment picker, SecretStorage), **.rbird → .rbl extraction**, **MCP served-graph registration** into `.vscode/mcp.json`, and a 3-step **walkthrough**.

It demonstrates the MVP thesis concretely: everything above runs against today's public surface with zero platform work.

## 10. Research corpus

Everything in this document traces to [`research/`](research/): platform/product (`product.md`), RBLang deep-dive (`rblang.md`), API surface (`api.md`), comparable-extension patterns (`comps.md`), VSCode platform capabilities (`vscode.md`), the MCP preview (`mcp-preview.md`), the incumbent-extension audit and Studio-editor reverse-engineering (`gap-0…`), undocumented RBLang syntax and the extracted validator schema (`gap-3…`), company/changelog status (`gap-4…`), and the four audience designs with adversarial feasibility verdicts (`design-*.md`). Verbatim extracted artifacts (Studio Ace mode, rblint worker, completions, structural schema, real `.rbird` maps, OpenAPI spec) are preserved under `/Users/julio/rblang-research/` and `/tmp/rbl-research/`.
