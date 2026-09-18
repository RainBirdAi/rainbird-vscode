# Developing the extension

The extension lives at the repository root. This folder holds the proposal, feature ideas and research behind it, none of which ship in the VSIX.

## Build and test

```bash
npm install
npm run compile
npm test          # linter unit tests (node:test, no VS Code host needed)
```

Open the repository in VS Code and press **F5** (Run Extension). In the Extension Development Host:

1. Open `examples/hello-world.rbl`. Highlighting, completions and diagnostics work offline. Click the graph icon in the editor title to see the map as a live graph.
2. **Rainbird: Connect**, pick an environment and paste an API key.
3. Click the play button, or **Rainbird: Run Query…**, set the kmID when prompted, pick a goal, answer the question cards and expand the evidence tree.
4. Open the **Rainbird** activity-bar icon, choose **AI Assistant** and paste an Anthropic API key when prompted (or **Rainbird: Set Anthropic API Key**). Try: *"Add a rule that people also speak the languages of countries they have lived in."* Requests use `claude-opus-5` by default, configurable via `rainbird.ai.model`.
5. **Rainbird: Push Map to Platform** uploads the buffer as a new map (create-only endpoint) and offers to query it immediately.

Try breaking the example: rename a concept, misspell an attribute, set `cf="150"`, or use a custom variable in a rule header. For the full tour, open `examples/broken/diagnostics-tour.rbl`: every diagnostic the linter knows, each preceded by an `EXPECT` comment saying what should appear in the Problems panel. The unit tests check that file block by block.

## Layout

| Path | Purpose |
|---|---|
| `src/` | Extension source. `lint.ts` is the editor-agnostic linter core; `diagnostics.ts` is its VS Code adapter. |
| `src/test/` | `node:test` suites run by `npm test`. |
| `syntaxes/`, `snippets/`, `language-configuration.json` | RBLang grammar, snippet catalogue and bracket/comment rules. |
| `examples/` | Sample maps used by the walkthrough and as the linter's error-free regression corpus. |
| `media/` | Icons and walkthrough pages. |
| `docs/` | Proposal, feature ideas and research. Excluded from the VSIX. |

## What is deliberately stubbed

See [PROPOSAL.md](PROPOSAL.md) for the intended architecture.

- The regex-based document index stands in for a proper language server (incremental XML parser, workspace-wide symbols). The formatter (`src/format.ts`) is indent-only for the same reason: reordering elements or attributes needs a parser that preserves comments.
- The graph view is read-only. There is no two-way visual editing.
- `<import>`ed maps are not resolved, so references to symbols defined in a linked map show as unknown.
- Push exists and pull works via `GET /analysis/file` (undocumented), but there is no update-in-place or delete against the platform. `POST /maps` is create-only.
- Packaging to `.rbird` was removed: Studio's importer relies on the structured model arrays, not the `rblang` lines, so a text-only repack imports broken.
- No chat participant or language-model tools (`@rainbird` in Copilot). The AI assistant uses the user's Anthropic key directly.

## Releasing

1. Bump `version` in `package.json` and add a dated `## <version> — <date>` entry to `CHANGELOG.md`.
2. Commit, then tag `v<version>` and push the branch and the tag: `git push origin main v<version>`.
3. The GitLab pipeline in `.gitlab-ci.yml` runs the tests, checks the tag matches the manifest version and that the changelog has a section for it, packages the VSIX with `vsce`, uploads it to the project's package registry, and creates a GitLab Release whose notes are that changelog section.
4. To publish to the VS Code Marketplace, run the manual **publish-marketplace** job on the tag pipeline. It needs a masked CI/CD variable `VSCE_PAT` holding a Marketplace personal access token for the `RainbirdTechnologies` publisher.

To check what will ship before tagging:

```bash
npx @vscode/vsce@3 ls
```

`.vscodeignore` keeps `src/`, tests, source maps, `docs/`, the CI config and any local `.env` files out of the package. `README.md`, `CHANGELOG.md` and `LICENSE` do ship and appear on the extension's Marketplace page, so keep internal material out of them.

## Provenance

- The structural schema, snippet catalogue and completion behaviour are clean-room reimplementations from Rainbird's public RBLang reference docs and observed Studio behaviour. No Studio code is copied.
- The example maps are adapted from Rainbird's public documentation examples.
- Several platform endpoints the extension uses (`POST /maps`, `GET /analysis/file`, `/nl/interact`, `/undo`) are not in the public API spec and were verified live. Their shapes may change.
