# Rainbird for VSCode — prototype

A working skeleton of the Rainbird VSCode extension proposed in [`PROPOSAL.md`](https://github.com/juliodt-ai/rainbird-vscode/blob/main/PROPOSAL.md). It demonstrates the MVP tier end-to-end: RBLang language support and a live query loop against the real Decisions API.

## Install a test build

1. Download the latest `.vsix` from the [Releases page](https://github.com/juliodt-ai/rainbird-vscode/releases).
2. In VSCode: **Extensions** view → `…` menu → **Install from VSIX…** (or run `code --install-extension rainbird-<version>.vsix`).
3. Open any `.rbl` file — the walkthrough (`Help: Get Started` → Rainbird) takes it from there.

Test builds do not auto-update: install the new `.vsix` from Releases when one is announced.

## What's implemented

| Area | Status |
|---|---|
| RBLang language (`.rbl`, `.rblang`) with TextMate grammar | ✅ Elements, attributes, enum values, embedded expression language (51 functions, `%VARS`, natural-language operators), `alt` interpolation (`{{%VAR.rel}}`), question-text placeholders |
| Diagnostics | ✅ Unknown elements/attributes, missing required attributes, invalid enum values, undeclared concept/relationship references, duplicate concept/relationship/instance declarations, non-string subjects, cf ranges, rule-header variable misuse, datasource hostname, illegal name characters, element nesting + mismatched closing tags, fact completeness + duplicate facts, subject/object type agreement (typed literals validated, string endpoints checked against declared instances), all-zero condition weights, single-use rule variables, unknown expression functions + unbalanced parens/quotes, mutex instance counts, orphan concepts, question-form placeholder coherence, **left-to-right evaluation order** (with parenthesise quick fixes + inlay hint), **reachability** (relationships only injected facts can satisfy; rules that can never fire), **recursive rules** |
| Completions | ✅ Context-aware: child elements by enclosing element, attribute names filtered by presence, enum values, map-local concept/relationship/instance names, expression functions with docs |
| Hovers | ✅ Element docs and expression-function signatures |
| Snippets | ✅ Full catalogue: skeleton, concepts, datasources (GET/POST), instances, relationships, facts, rules (incl. top-down), all three condition forms, list-function conditions, import, compound |
| Query panel | ✅ `Rainbird: Run Query…` — interactive webview: goal picker from the open map, optional subject **and object** (subject, object and certainty queries), **draft / live / version** target, **facts to inject** (JSON/CSV or a fixture file), question **cards** (grouped questions answered together, yes/no buttons, option chips, multi-select, certainty sliders, `allowUnknown` skip, `canAdd` free text, **↶ Back** via `/undo`), running transcript, result cards with certainty bars and **inline evidence trees**. (The original QuickPick loop survives as `Run Query (Quick Pick)…`) |
| Graph view | ✅ Force-directed graph of the open map — typed concept nodes, labelled relationship edges with rule/fact counts, instances orbiting their concepts. Click anything to jump to its source line; re-renders live as you type. Editor-title button on `.rbl` files |
| AI assistant | ✅ Sidebar chat (Rainbird activity-bar icon) powered by Claude via your Anthropic API key (SecretStorage): describe logic → get valid RBLang, explain maps, fix problems. Generated code is **linted with the extension's own diagnostics before it's offered**, with one-click Insert / Replace file / Ask-to-fix. The system prompt is generated from the same schema table the linter uses |
| Push to platform | ✅ `Rainbird: Push Map to Platform` — uploads the open `.rbl` via the (undocumented, verified) `POST /maps` endpoint; lints first, warns about create-only semantics, remembers the returned kmID per file, chains into the query panel |
| Map explorer | ✅ Sidebar tree of the active map's concepts / relationships / rules / instances; click to reveal source |
| Evidence overlay | ✅ "Show on graph" on any query result projects the decision's inference path onto the graph view — used relationships/instances highlighted with certainty, everything else dimmed |
| AI decision explanation | ✅ "Explain (AI)" on any result streams a plain-English narrative of why the engine decided what it did (per-fact provenance: told-to-us / inferred / datasource) |
| Regression tests | ✅ "Save as test" on any finished query writes a `.rbtest.json` (goal + target version + injected facts + answers + expected results); the **Test Explorer** replays them against the recorded target (draft by default) with certainty-drift detection (±2) |
| Agentic assistant | ✅ The AI assistant has tools — `lint_map`, `run_query`, `push_map` (push is confirmation-gated) — so "build a map for X and prove it works" lints, pushes and queries autonomously |
| Go-to-def / references / rename | ✅ For concepts, relationships and instances (space-containing names handled); rename updates every reference **including quoted names inside expressions, `{{%VAR.rel}}` evidence-text traversals and datasource `action map=` targets**. Single-file scope |
| Quick fixes | ✅ 💡 on diagnostics: declare a missing instance, did-you-mean renames for case/typo'd references (edit distance ≤ 2), pick a valid enum value, add missing / remove unrecognised attributes, delete duplicate declarations & facts — every fix generated by the lint engine itself, so applying it provably clears the diagnostic |
| Outline & folding | ✅ DocumentSymbolProvider (Outline pane, breadcrumbs, Cmd+Shift+O, sticky scroll): concepts, instances, relationships with question forms, rules with their conditions, facts. Structure-based folding for elements and comment blocks |
| CodeLens | ✅ "▶ Run query" and rule/fact counts above every `<rel>`, pre-selecting the goal in the query panel |
| NL querying | ✅ `Rainbird: Ask in Natural Language (beta)` — Rainbird's own `/nl/interact` (endpoint verified live, body shape undocumented → defensive parsing with a raw-JSON expander on every reply) |
| Semantic diff | ✅ `Rainbird: Semantic Diff` — model-level diff vs git HEAD (or a picked `.rbl` / `.rbird` base): concepts/rels/instances/facts/rules added·removed·changed, cf drifts, renamed rules paired, per-condition weight/mandatory changes — a markdown report, not XML noise |
| Promotion diff | ✅ `Rainbird: Compare Versions (Promotion Diff)…` (also on every result card) — replays a saved test or the last panel session against two versions of the same map (draft vs live by default, any version number) and reports result/certainty changes plus, when evidence is accessible, the facts, rule conditions and impacts that moved. Studio has no version diff |
| Draft vs saved version | ✅ `Rainbird: Compare Draft vs Saved Version…` — the platform draft (or the open `.rbl`, or a Studio `.rbird` export) against the latest / live / numbered saved version fetched from the platform, or another export. Model-level semantic report plus an optional side-by-side text diff. Also on right-click of any `.rbird`. Studio itself has no version diff |
| Pull from platform | ✅ `Rainbird: Pull Map RBLang from Platform…` — read-only RBLang of the draft or any saved version via `GET /analysis/file/{kmID}[?version=N]` (verified live, undocumented), with Save As. `Rainbird: Diff Open File Against Platform Draft` compares the buffer with what the platform actually holds |
| Quick diff vs pushed snapshot | ✅ Gutter change bars (SCM quick-diff provider) and `Rainbird: Diff Against Last Pushed Snapshot` compare the buffer with exactly what was last pushed from VSCode |
| Package as .rbird | ❌ Removed — the round-trip test failed: Studio's importer relies on the structured model arrays, not the `rblang` lines, so a text-only repack imports broken. Rebuilding those arrays needs the full parser (see PROPOSAL.md). Push via `POST /maps` is the working VSCode→platform path |
| Maps view | ✅ Per-environment registry of every kmID you push/query/add (there is still **no public list-maps API** — `GET /maps` → 404, verified; platform ask \#8). Clicking a map opens its **live platform draft** read-only (`GET /analysis/file`), falling back to the pushed file or snapshot. Probes `GET /maps` on refresh so it upgrades to a live listing if it ever ships |
| Evidence tree | ✅ Webview with recursive evidence expansion, source colour-coding per docs, per-condition impact/salience |
| Connection management | ✅ Environment picker (Community/Enterprise/custom), API key in SecretStorage, status bar item |
| `.rbird` interop | ✅ `Rainbird: Extract RBLang from .rbird export` (gunzip → JSON → `.rbl`) |
| MCP | ✅ `Rainbird: Add Served Graph as MCP Server…` writes the served-graph endpoint into `.vscode/mcp.json` for Copilot agent mode |
| Walkthrough | ✅ 3-step Getting Started |

## What's deliberately stubbed (see PROPOSAL.md for the real architecture)

- The regex-based document index stands in for a proper **language server** (incremental XML parser, workspace-wide symbols, rename, go-to-definition, formatting).
- The graph view is **read-only** — no two-way visual editing (CustomTextEditorProvider sync, Miragon/drawio pattern).
- No **test explorer** integration for Studio automated tests / graded evals.
- Push exists and **pull** now works (`GET /analysis/file`, undocumented), but there is still no **update-in-place or delete** against the platform — `POST /maps` is create-only; update semantics are platform ask \#1 in the proposal.
- No **chat participant / language-model tools** (`@rainbird` in Copilot) — the AI assistant uses your Anthropic key directly instead.

## Run it

```bash
cd prototype
npm install
npm run compile
```

Then open this folder in VSCode and press **F5** (Run Extension). (From the repo root, the top-level `.vscode/launch.json` does the same.) In the Extension Development Host:

1. Open `examples/hello-world.rbl` — highlighting, completions, diagnostics work offline. Click the graph icon in the editor title to see the map as a live graph.
2. `Rainbird: Connect` — pick an environment, paste an API key.
3. Click ▶ (or `Rainbird: Run Query…`) — set the kmID when prompted, pick a goal, answer the question cards, and expand the evidence tree inline.
4. Open the **Rainbird** icon in the activity bar → **AI Assistant** → paste an Anthropic API key when prompted (or `Rainbird: Set Anthropic API Key`). Try: *“Add a rule that people also speak the languages of countries they have lived in.”* Requests run on `claude-opus-5` (configurable via `rainbird.ai.model`) with server-side refusal fallback enabled.
5. `Rainbird: Push Map to Platform` uploads the buffer as a **new** map (create-only endpoint) and offers to query it immediately.

Try breaking the example: rename a concept, misspell an attribute, set `cf="150"`, or use a custom variable in a rule header — the linter catches each one (and the AI assistant's generated code is checked against the same linter before you insert it).

## Provenance notes

- The structural schema, snippet catalogue and completion behaviour are **clean-room reimplementations** from Rainbird's public RBLang reference docs and observed Studio behaviour — no Studio code is copied.
- The two example maps are adapted from Rainbird's public documentation examples.
- MCP endpoint URLs are self-authenticating secrets: the extension stores them only in your workspace's `.vscode/mcp.json` and masks input.
