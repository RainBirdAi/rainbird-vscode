# Rainbird for VS Code

Author, check, query and ship Rainbird knowledge maps without leaving your editor.

> **Beta.** Commands, file formats and some platform endpoints this extension relies on may change between releases. Test builds do not auto-update. Please report problems and ideas on [GitHub Issues](https://github.com/juliodt-ai/rainbird-vscode/issues).

Rainbird is a decision-intelligence platform. Its knowledge maps are written in **RBLang**, an XML dialect that declares concepts, relationships, facts and rules. This extension turns VS Code into a first-class RBLang editor and connects it to your Rainbird environment so you can run real queries, read the evidence behind every answer, and push maps to the platform.

## Features

### Write RBLang with confidence

- **Syntax highlighting** for elements, attributes, enum values and the expression language inside `expression="…"`, including `%VARIABLES` and natural-language operators.
- **Diagnostics as you type**, matched check by check against Studio's validator: unknown or misspelled elements and attributes, missing required attributes, invalid values, undeclared or duplicate concepts, relationships and instances, type mismatches in facts and conditions, certainty out of range, unbalanced quotes and unclosed elements, expression precedence traps, rules that can never fire, recursive rules, and more.
- **Quick fixes** on most problems: declare a missing instance, accept a did-you-mean rename, pick a valid value, add or remove attributes, delete duplicates, parenthesise an expression.
- **Completions and hovers** that know your map: child elements by context, attribute names, enum values, the concepts, relationships and instances you have declared, and every expression function with its documentation.
- **Navigation**: go to definition, find references and rename for concepts, relationships and instances. Rename also updates quoted names inside expressions and evidence text.
- **Outline, breadcrumbs and folding** for the structure of the map, plus a full snippet catalogue.

### Author without memorising the syntax

- **Guided authoring**: use **Rainbird: Insert…** from the editor title bar, the right-click menu or the Map Explorer to add a concept, relationship, instance, fact, rule or condition by answering a few plain-English questions. Choices come from what the map already declares, and the element is inserted in the recommended section of the file.
- **CodeLens** above every relationship and rule to run it as a query or add a fact, rule or condition in place.
- **Map Explorer** in the Rainbird sidebar lists the concepts, relationships, rules, facts and instances of the open map. Click any item to jump to its source.
- **Graph view** shows the open map as a live, force-directed graph. Click a node or edge to jump to its line.

### Query the real engine and see the evidence

- **Run Query** opens an interactive panel: pick a goal from the open map, optionally set a subject and object, choose draft, live or a specific version, inject facts, and answer the engine's questions as cards with yes/no buttons, option chips, sliders and free text. Step back with Undo.
- **Results** show certainty bars and an **inline evidence tree** explaining how each answer was reached, colour-coded by source.
- **Show on graph** projects the inference path of a result onto the graph view.
- **Explain with AI** turns a result into a plain-English narrative of why the engine decided what it did.
- **Ask in Natural Language** sends a free-text question to Rainbird's natural-language endpoint.

### Work with the platform

- **Connect** once per environment. Your API key is stored in VS Code's encrypted secret storage, never in settings files.
- **Push Map to Platform** uploads the open file as a new map. The extension lints the map first, then shows any validation message the platform returns in the Problems panel on the element it refers to.
- **Pull Map RBLang from Platform** opens the draft or any saved version of a map as read-only RBLang.
- **Maps view** keeps a per-environment list of the maps you have pushed, queried or added by ID. Open a map's live draft or run a query straight from the list.
- **Extract RBLang from .rbird export** unpacks a Studio export into an editable `.rbl` file.
- **Add Served Graph as MCP Server** registers a served-graph endpoint in `.vscode/mcp.json` for use in Copilot agent mode.

### Compare and test

- **Side-by-side diffs** against git HEAD, the platform draft, a saved version, a Studio export or the last snapshot you pushed. Each comes with a **semantic report** that lists the concepts, relationships, facts and rules that were added, removed or changed, rather than line noise.
- **Promotion diff** replays a saved test or your last query session against two versions of the same map and reports every result and certainty that moved.
- **Regression tests**: save any finished query as a `.rbtest.json`. The Test Explorer replays it against the recorded target and flags certainty drift.

### AI assistant

The Rainbird sidebar includes a chat assistant powered by Claude using your own Anthropic API key. Describe the logic you want and get valid RBLang, ask it to explain a map, or ask it to fix a problem. Generated code is checked with the extension's own linter before it is offered, and the assistant can lint, query and push on your behalf. Pushing always asks for confirmation.

## Requirements

- VS Code 1.90 or later.
- A Rainbird account and API key for querying and pushing. The key and the Knowledge Map ID are on the map's **Publish** page in Rainbird Studio. Editing, linting and the graph view work offline.
- An Anthropic API key if you want to use the AI assistant.
- To see evidence trees, enable the map's **Evidence Tree Link** in Studio under Publish, API Management, Access Control.

## Getting started

1. Install the extension. Until it is listed on the Marketplace, download the latest `.vsix` from [Releases](https://github.com/juliodt-ai/rainbird-vscode/releases) and use **Extensions: Install from VSIX…** or:

   ```bash
   code --install-extension rainbird-<version>.vsix
   ```

2. Open any `.rbl` file, or run **Help: Get Started** and choose **Get started with Rainbird** for a three-step walkthrough with an example map.
3. Run **Rainbird: Connect**, pick Community, Enterprise or a custom URL, and paste your API key.
4. Click the play button in the editor title bar, or run **Rainbird: Run Query…**. Enter the Knowledge Map ID when prompted, pick a goal, answer the questions and expand the evidence tree.
5. Optional: open the **Rainbird** icon in the activity bar, choose **AI Assistant** and paste an Anthropic API key when prompted.

## Commands

All commands are available from the Command Palette. The most used ones:

| Command | What it does |
|---|---|
| Rainbird: Connect | Choose an environment and store an API key |
| Rainbird: Run Query… | Open the interactive query panel for the open map |
| Rainbird: Show Graph View | Show the open map as a live graph |
| Rainbird: Insert… | Guided authoring of a concept, relationship, instance, fact, rule or condition |
| Rainbird: Push Map to Platform | Upload the open file as a new map |
| Rainbird: Pull Map RBLang from Platform… | Open the draft or a saved version as read-only RBLang |
| Rainbird: Diff vs git HEAD… | Side-by-side diff with a semantic report |
| Rainbird: Diff Open File Against Platform Draft | Check whether your file matches the platform draft |
| Rainbird: Compare Draft vs Saved Version… | Compare the platform draft with a saved version or an export |
| Rainbird: Compare Versions (Promotion Diff)… | Replay a test or session against two versions |
| Rainbird: Ask in Natural Language (beta)… | Free-text question against the engine |
| Rainbird: Explain with AI | Plain-English explanation of the selection or a result |
| Rainbird: Extract RBLang from .rbird export | Convert a Studio export to `.rbl` |
| Rainbird: Add Served Graph as MCP Server… | Register a served graph in `.vscode/mcp.json` |
| Rainbird: Set Anthropic API Key | Store the key used by the AI assistant |
| Rainbird: Set Evidence Key | Store the evidence key a map requires for evidence trees |

## Settings

| Setting | Default | Description |
|---|---|---|
| `rainbird.apiUrl` | `https://api.rainbird.ai` | API base URL. Use `https://enterprise-api.rainbird.ai` for Enterprise or your private environment URL. |
| `rainbird.knowledgeMapId` | empty | Knowledge Map ID that queries run against. The extension also remembers the ID returned by each push per file. |
| `rainbird.useDraft` | `true` | Query the draft version of the map instead of the live version. |
| `rainbird.ai.model` | `claude-opus-5` | Claude model used by the AI assistant. |

API keys are never stored in settings. Use **Rainbird: Connect** and **Rainbird: Set Anthropic API Key** to change them.

## File types

| Extension | Purpose |
|---|---|
| `.rbl`, `.rblang` | RBLang knowledge maps. Full language support. |
| `.rbird` | Studio exports. Right-click to extract RBLang or compare against the platform. |
| `.rbtest.json` | Saved query sessions replayed by the Test Explorer. |
| `.facts.json` | Fact fixtures that can be injected into a query. |

## Known limitations

- **Push creates a new map** every time. The platform API has no update-in-place or delete, so promote changes through Studio.
- **Linked maps** are not resolved. References to symbols declared in an imported map are reported as unknown.
- **Single-file scope.** Navigation, rename and diagnostics work within the open file. There is no workspace-wide index yet.
- **The graph view is read-only.** Edit the RBLang, and the graph follows.
- **No map listing** from the platform. The Maps view shows the maps you have pushed, queried or added by ID.
- **Packaging to `.rbird`** is not supported. Studio's importer needs its structured model, not just the RBLang text. Use Push instead.

## Privacy

- Rainbird API keys, the evidence key and the Anthropic API key are stored in VS Code's secret storage.
- The AI assistant sends the text of the open map and your prompts to Anthropic using your own key. Nothing is sent unless you use the assistant or an AI command.
- MCP endpoint URLs are self-authenticating secrets. They are written only to your workspace's `.vscode/mcp.json` and masked on input.

## Release notes

See the [changelog](CHANGELOG.md).

## Contributing and background

Development setup, test instructions and the product research behind this extension are in [docs/](https://github.com/juliodt-ai/rainbird-vscode/tree/main/docs).

## Licence

See [LICENSE](LICENSE).
