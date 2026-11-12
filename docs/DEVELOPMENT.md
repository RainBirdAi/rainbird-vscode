# Developing the extension

The extension lives at the repository root. This folder holds the proposal, feature ideas and research behind it, none of which ship in the VSIX.

## Build and test

```bash
npm install
npm run compile
npm test                   # unit tests (node:test, no VS Code needed); clears out/ first
npm run test:integration   # the extension in a real VS Code, downloaded into .vscode-test/
```

Both run in the GitLab pipeline on every push and merge request (jobs `test` and `integration`), and a release tag is only packaged when both pass.

- **Unit tests** (`src/test/`) cover the VS Code-free modules, plus `manifest.test.ts`, which checks `package.json` against the code: one language id everywhere, every contributed command registered, every referenced file present. The tests that run over `examples/` fail if the bundled examples are missing, so they cannot pass by finding nothing.
- **Integration tests** (`src/integration/`) launch VS Code twice with a throwaway profile and workspace (`fixture.ts`). Inside VS Code (`suite.ts`) they check activation, language registration, that legacy `.rbl`/`.rblang` and associated files open as Raelog, diagnostics, document symbols, completions, hovers, formatting, that every contributed command is registered, and the migration of settings saved under the old `rblang` id. Afterwards `runTest.ts` checks the settings files and snapshots left on disk, and that the second launch changed nothing. They are safe to run from VS Code's own terminal (the variables that would make the test VS Code misbehave are removed). On Linux they need a display: CI uses `xvfb-run`.

Open the repository in VS Code and press **F5** (Run Extension). In the Extension Development Host:

1. Open `examples/hello-world.raelog`, a small model written in Raelog. Highlighting, completions and diagnostics work offline. Click the graph icon in the editor title to see the model as a live graph.
2. **Rae: Connect**, pick an environment and paste an API key.
3. Click the play button, or **Rae: Run Query…**, set the kmID when prompted, pick a goal, answer the question cards and expand the evidence tree.
4. Open the **Rainbird** activity-bar icon, choose **AI Assistant** and paste an Anthropic API key when prompted (or **Rae: Set Anthropic API Key**). Try: *"Add a rule that people also speak the languages of countries they have lived in."* — the assistant reads the model, edits it through `edit_map`, and the chat shows a Changes card with Show diff / Undo. Requests use the Claude model `claude-opus-5` by default (`rainbird.ai.model`), `high` effort (`rainbird.ai.effort`), and apply edits directly (`rainbird.ai.applyEdits`; set `preview` to Accept/Reject a diff instead).
5. **Rae: Push Model to Platform** uploads the buffer as a new model (create-only endpoint) and offers to query it immediately.

Try breaking the example: rename a concept, misspell an attribute, set `cf="150"`, or use a custom variable in a rule header. For the full tour, open `examples/broken/diagnostics-tour.raelog`: every diagnostic the linter knows, each preceded by an `EXPECT` comment saying what should appear in the Problems panel. The unit tests check that file block by block.

## Layout

| Path | Purpose |
|---|---|
| `src/` | Extension source. `lint.ts` is the editor-agnostic linter core; `diagnostics.ts` is its VS Code adapter. |
| `src/knowledge/` | The Raelog / Rae reference the assistant carries in its system prompt (hand-written topic modules + tables generated from `schema.ts`), the behaviour prompt, and the worked examples the tests lint. |
| `src/agentLoop.ts`, `toolSchemas.ts`, `mapOverview.ts`, `assistantContext.ts`, `mapEdits.ts`, `semanticModel.ts` | VS Code-free assistant core: request shaping and tool loop, tool input validation, model overview, context header, the edit engine, the semantic model. Unit-tested. |
| `src/anthropic.ts`, `assistantSession.ts`, `assistantTools.ts`, `editApplier.ts`, `assistantView.ts`, `media/assistant/` | VS Code glue for the assistant: key + settings, per-chat state and turn orchestration, tool bodies, immediate/preview edit application, the webview provider and its script/styles. |
| `src/test/` | `node:test` suites run by `npm test`. |
| `src/integration/` | Integration tests in a real VS Code, run by `npm run test:integration`. |
| `src/fileTypes.ts`, `src/languageMigration.ts` | Raelog file extensions and names, and the rules for moving settings from the old `rblang` id; VS Code-free and unit-tested. `src/migrate.ts` applies the migration at activation. |
| `syntaxes/`, `snippets/`, `language-configuration.json` | Raelog grammar, snippet catalogue and bracket/comment rules. |
| `examples/` | Sample models used by the walkthrough and as the linter's error-free regression corpus. |
| `media/` | Icons and walkthrough pages. |
| `docs/` | Proposal, feature ideas and research. Excluded from the VSIX. |

## What is deliberately stubbed

See [PROPOSAL.md](PROPOSAL.md) for the intended architecture.

- The regex-based document index stands in for a proper language server (incremental XML parser, workspace-wide symbols). The formatter (`src/format.ts`) is indent-only for the same reason: reordering elements or attributes needs a parser that preserves comments.
- The graph view is read-only. There is no two-way visual editing.
- `<import>`ed models are not resolved, so references to symbols defined in a linked model show as unknown.
- Push exists and pull works via `GET /analysis/file` (undocumented), but there is no update-in-place or delete against the platform. `POST /maps` is create-only.
- Packaging to `.rbird` was removed: Studio's importer relies on the arrays that hold Studio's structured form of the model, not the `rblang` lines, so a text-only repack imports broken.
- No chat participant or language-model tools (`@rainbird` in Copilot). The AI assistant uses the user's Anthropic key directly; its tools are not exposed to other agents.

## Releasing

1. Bump `version` in `package.json` and add a dated `## <version> — <date>` entry to `CHANGELOG.md`.
2. Commit, then tag `v<version>` and push the branch and the tag: `git push origin main v<version>`.
3. The GitLab pipeline in `.gitlab-ci.yml` runs the tests, checks the tag matches the manifest version and that the changelog has a section for it, packages the VSIX with `vsce`, uploads it to the project's package registry, and creates a GitLab Release whose notes are that changelog section.
4. To publish to the VS Code Marketplace, run the manual **publish-marketplace** job on the tag pipeline. It uses no Marketplace token: it signs in to Microsoft Entra ID with GitLab's OIDC token (workload identity federation). That needs CI/CD variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` for an Entra app registration whose federated credential trusts this project's `v*` tags, and the app must be a Contributor on the `RainbirdTechnologies` publisher; the manual **marketplace-identity** job prints the ID to add as a publisher member (run it once). To publish to Open VSX, run the manual **publish-openvsx** job, which needs a masked CI/CD variable `OVSX_PAT` with publish rights on the `RainbirdTechnologies` namespace.
5. Once a publish job has run, **verify-marketplace** or **verify-openvsx** starts by itself. It waits until the store serves the new version under the manifest's display name (up to 20 minutes for the Marketplace, which scans every upload first, and 10 for Open VSX) and fails the pipeline if it does not. A failed publish job alone shows only as a warning, so a red verify job is the signal to look at. To check by hand: `node scripts/verify-published.mjs marketplace` (or `openvsx`).

To check what will ship before tagging:

```bash
npx @vscode/vsce@3 ls
```

`.vscodeignore` keeps `src/`, tests, source maps, `docs/`, the CI config and any local `.env` files out of the package, and also what CI writes into the checkout before packaging (the `.npm/` cache, `release-notes.md`); a test in `src/test/manifest.test.ts` fails when a CI cache path or written file is missing from it. `README.md`, `CHANGELOG.md` and `LICENSE` do ship and appear on the extension's Marketplace page, so keep internal material out of them.

## Provenance

- The structural schema, snippet catalogue and completion behaviour are clean-room reimplementations from Rainbird's public reference docs for Raelog and observed Studio behaviour. No Studio code is copied.
- The example models are adapted from Rainbird's public documentation examples.
- Several platform endpoints the extension uses (`POST /maps`, `GET /analysis/file`, `/nl/interact`, `/undo`) are not in the public API spec and were verified live. Their shapes may change.
