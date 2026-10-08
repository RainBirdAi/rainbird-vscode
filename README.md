# Rainbird for VS Code

[![Pipeline status](https://gitlab.com/rainbird-ai/labs/rainbird-vscode/badges/main/pipeline.svg)](https://gitlab.com/rainbird-ai/labs/rainbird-vscode/-/pipelines)

Author, check, query and ship Rainbird knowledge maps without leaving your editor.

> **Beta.** Commands, file formats and some platform endpoints this extension relies on may change between releases. Please report problems and ideas on [GitHub Issues](https://github.com/RainBirdAi/rainbird-vscode/issues).

Rainbird is a decision-intelligence platform. Its knowledge maps are written in **RBLang**, an XML dialect that declares concepts, relationships, facts and rules. This extension turns VS Code into a first-class RBLang editor and connects it to your Rainbird environment so you can run real queries, read the evidence behind every answer, and push maps to the platform.

## Features

### Write RBLang with confidence

- **Syntax highlighting** for elements, attributes, enum values and the expression language inside `expression="…"`, including `%VARIABLES` and natural-language operators.
- **Diagnostics as you type**, matched check by check against Studio's validator: unknown or misspelled elements and attributes, missing required attributes, invalid values, undeclared or duplicate concepts, relationships and instances, type mismatches in facts and conditions, certainty out of range, unbalanced quotes and unclosed elements, expression precedence traps, rules that can never fire, relationships that are never used, recursive rules, and more.
- **Quick fixes** on most problems: declare a missing instance, accept a did-you-mean rename, pick a valid value, add or remove attributes, delete duplicates, parenthesise an expression.
- **Completions and hovers** that know your map: child elements by context, attribute names, enum values, the concepts, relationships and instances you have declared, and every expression function with its documentation.
- **Navigation and rename**: go to definition, find references and rename for concepts, relationships and instances. Edit a name where it is declared and every mention follows as you type (linked editing, on by default for `.rbl` files); or press `F2` on any mention. Rename also updates quoted names inside expressions, evidence text and datasource maps, and an instance rename stays within the instance's concept (`France` the Country, not `France` the Team). Hover a name to see what uses it.
- **Outline, breadcrumbs and folding** for the structure of the map, plus a full snippet catalogue.
- **Formatting** with **Format Document**, **Format Selection** or `editor.formatOnSave`. Each line is re-indented from the element nesting and trailing whitespace is trimmed; the file's line breaks, blank lines, comments, wrapped attributes and element order are kept as written.

### Author without memorising the syntax

- **Guided authoring**: use **Rainbird: Insert…** from the editor title bar, the right-click menu or the Map Explorer to add a concept, relationship, instance, fact, rule or condition by answering a few plain-English questions. Choices come from what the map already declares, and the element is inserted in the recommended section of the file.
- **CodeLens** above every relationship and rule to run it as a query or add a fact, rule or condition in place.
- **Map Explorer** in the Rainbird sidebar lists the concepts, relationships, rules, facts and instances of the open map. Click any item to jump to its source.
- **Graph view** shows the open map as a live, force-directed graph. Click a node or edge to jump to its line.

### Query the real engine and see the evidence

- **Run Query** opens an interactive panel: find the goal by typing part of a relationship's name, subject or object (the relationship of the rule, fact or declaration under the cursor is preselected, and the last goal for each map is remembered), give a subject, an object or both, choose draft, live or a specific version, inject facts, and answer the engine's questions. **Change…** in the panel's header points it at another map. **Back** undoes the last answer.
- **Answers in the form the engine expects.** Truth questions show True and False. Number questions have a number field with a format hint. Date questions accept dates typed naturally, such as `1 October 1981` or `1981-10-01`, or picked from a calendar, and send them as `YYYY-MM-DD`. A numeric date that could be read either way, such as `01/10/1981`, is never guessed: the card offers both readings, day first by default (`rainbird.query.dateOrder`). Options from the map appear as buttons or chips, with a filter for long lists. If the engine rejects an answer, the card keeps your answers. For a single question it says what format it expects; on a grouped card, where the engine does not say which answer failed, it asks you to fix the one in question.
- **Grouped questions** arrive on one card that works like a form: fill in every answer, then send them together with a single **Submit answers**.
- **Known answers.** Cards show what the engine already knows for a question. Plural questions with known answers offer **No more**, single-answer ones **Keep known answer**. By default the panel answers **No more** for you when the facts you injected cover every question on the card (`rainbird.query.autoSkipPluralQuestions`); on a larger card the covered questions start on **No more**. The transcript shows each automatic skip with **Answer instead**.
- **Results** show certainty bars and an inline **evidence tree** laid out like Studio's: the result as a card, each rule's conditions as rows with the source, certainty and impact of the fact behind each, a nested card where another rule inferred that fact, every fact a list function used, and an **Inputs used by this result** list. **Open in Studio** and **Copy link** open or share the same tree in Rainbird Studio (while the session lasts), and **Open in panel** gives it its own tab.
- **Show on graph** projects the inference path of a result onto the graph view.
- **Explain (AI)** under a result turns it into a plain-English narrative of why the engine decided what it did.
- **Ask in Natural Language** sends a free-text question to Rainbird's natural-language endpoint.

### Work with the platform

- **Connect** once per environment. Your API key is stored in VS Code's encrypted secret storage, never in settings files.
- **Open Map by Knowledge Map ID** downloads a map's draft and saves it as an editable `.rbl` that remembers which map it came from, so queries, diffs and the assistant need no ID. The Knowledge Map ID is on the map's **Publish** page in Studio.
- **Push Map to Platform** uploads the open file as a new map and binds the file to the new map. The extension lints the map first, then shows any validation message the platform returns in the Problems panel on the element it refers to.
- **Pull Map RBLang from Platform** opens the draft or any saved version of a map as read-only RBLang, for reading and diffing. **Save as .rbl…** turns it into a file bound to that map. **Reload Map from Studio**, or the cloud button on a map in the Maps view, brings a bound file up to date after the map was edited in Studio.
- **Bind Open File to a Knowledge Map ID** tells the extension which map an exported or pasted file is a copy of.
- **Maps view** keeps a per-environment list of the maps you have opened, pushed, queried or added by ID. Open a map's current draft or run a query straight from the list. It is not a listing of your Studio account (see Known limitations).
- **Extract RBLang from .rbird export** unpacks a Studio export into an editable `.rbl` file.
- **Add Served Graph as MCP Server** registers a served-graph endpoint in `.vscode/mcp.json` for use in Copilot agent mode.

### Compare and test

- **Side-by-side diffs** against git HEAD, the platform draft, a saved version, a Studio export, or the snapshot of the draft you last downloaded into a file or last pushed. Each comes with a **semantic report** that lists the concepts, relationships, facts and rules that were added, removed or changed, rather than line noise.
- **Promotion diff** replays a saved test or your last query session against two versions of the same map and reports every result and certainty that moved.
- **Regression tests**: save any finished query as a `.rbtest.json`. The Test Explorer replays it against the recorded target and flags certainty drift.

### AI assistant

The Rainbird sidebar includes a Co-author-style assistant powered by Claude, using your own Anthropic API key. It knows RBLang and the Rainbird reasoning model in depth (a bundled reference covering concepts, relationships, rules, expressions, datasources, the certainty model and Match → Infer → Ask), and it works on the map you have open:

- **Ask about the map** — "which rules infer *has risk level*?", "why would this never ask about postcode?", "explain this rule" — and it answers from the map's actual content, naming rules and lines.
- **Ask for changes** — "add a rule that applicants over 65 skip the income check", "add question wording to every askable relationship", "fix every error" — and it edits the file through validated element-level operations (insert, replace, delete, set attribute), re-lints, fixes what it broke and summarises the change. By default edits land directly in the editor, each one undoable, with a per-turn **Changes** card offering **Show diff** and **Undo this turn**; set `rainbird.ai.applyEdits` to `preview` to review a side-by-side diff and **Accept** or **Reject** instead.
- **Start a map** from a description when no file is open.
- **Test it live** — with a connection it can push the map (always asking first), run queries against the draft, fetch evidence trees, replay saved regression tests and compare the map with git HEAD or the last pulled or pushed snapshot.

## Requirements

- VS Code 1.90 or later.
- A Rainbird account and API key for opening maps from the platform, querying and pushing. The key and the Knowledge Map ID are on the map's **Publish** page in Rainbird Studio; the ID is also under **View Knowledge Map ID** in the map details menu. Editing, linting and the graph view work offline.
- An Anthropic API key if you want to use the AI assistant.
- To see evidence trees, enable the map's **Evidence Tree Link** in Studio under Publish, API Management, Access Control. **Open in Studio** works out the Studio address from `rainbird.apiUrl` for Rainbird-hosted environments; for other hosts, set `rainbird.studioUrl`.

## Getting started

1. Install **Rainbird** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=RainbirdTechnologies.rainbird), or from the Extensions view in VS Code, or from a terminal:

   ```bash
   code --install-extension RainbirdTechnologies.rainbird
   ```

2. Run **Rainbird: Connect**, pick Community, Enterprise or a custom URL, and paste the API key from your map's **Publish** page in Rainbird Studio.
3. Run **Rainbird: Open Map by Knowledge Map ID…**, paste the map's Knowledge Map ID, which is on the same page, and choose where to save the `.rbl` (your open folder by default): it opens bound to that map. Two other routes work too: export a `.rbird` from Studio and right-click it to **Extract RBLang**, or paste the RBLang from Studio's `</>` code panel into a new file. To look around without an account, run **Help: Get Started**, choose **Get started with Rainbird** and click **Open example**; you can explore the example map offline, but it must be pushed to your account before it can be queried.
4. Click the play button in the editor title bar, or run **Rainbird: Run Query…**. Type part of the goal relationship's name and pick it, give a subject or an object, and click **Start query**. Answer the questions, then click **Show evidence** under the result. For an exported or pasted file, run **Rainbird: Bind Open File to a Knowledge Map ID…** first, or enter the ID when prompted (it becomes the folder's default map).
5. Optional: open the **Rainbird** icon in the activity bar, choose **AI Assistant** and paste an Anthropic API key when prompted.

## Commands

All commands are available from the Command Palette. The most used ones:

| Command | What it does |
|---|---|
| Rainbird: Connect | Choose an environment and store an API key |
| Rainbird: Open Map by Knowledge Map ID… | Download a map's draft by its Knowledge Map ID and save it as an editable `.rbl` bound to that map |
| Rainbird: Run Query… | Open the interactive query panel for the open map |
| Rainbird: Show Graph View | Show the open map as a live graph |
| Rainbird: Insert… | Guided authoring of a concept, relationship, instance, fact, rule or condition |
| Rainbird: Push Map to Platform | Upload the open file as a new map and bind the file to it |
| Rainbird: Pull Map RBLang from Platform (read-only draft or saved version)… | Open the draft or a saved version read-only, with **Save as .rbl…** |
| Rainbird: Reload Map from Studio | Replace the open, bound file with the map's current draft (warns first if you changed the file) |
| Rainbird: Get Started | Open the getting-started walkthrough |
| Rainbird: Bind Open File to a Knowledge Map ID… | Tell the extension which map the open file is a copy of |
| Rainbird: Diff vs git HEAD… | Side-by-side diff with a semantic report |
| Rainbird: Diff Open File Against Platform Draft | Check whether your file matches the platform draft |
| Rainbird: Diff Against Last Pulled or Pushed Snapshot | Side-by-side diff with the draft you last downloaded into a file, or what you last pushed, for this file's map |
| Rainbird: Compare Draft vs Saved Version… | Compare the platform draft with a saved version or an export |
| Rainbird: Compare Versions (Promotion Diff)… | Replay a test or session against two versions |
| Rainbird: Ask in Natural Language (beta)… | Free-text question against the engine |
| Rainbird: Explain with AI | Plain-English explanation of the selected RBLang, from the AI assistant (for a query result, use **Explain (AI)** in the query panel) |
| Rainbird: Show Evidence Tree for Fact… | Open the evidence tree for a session and fact ID in its own tab |
| Rainbird: Extract RBLang from .rbird export | Convert a Studio export to `.rbl` |
| Rainbird: Add Served Graph as MCP Server… | Register a served graph in `.vscode/mcp.json` |
| Rainbird: Set Anthropic API Key | Store the key used by the AI assistant |
| Rainbird: Set Evidence Key | Store the evidence key a map requires for evidence trees |

## Settings

| Setting | Default | Description |
|---|---|---|
| `rainbird.apiUrl` | `https://api.rainbird.ai` | API base URL. Use `https://enterprise-api.rainbird.ai` for Enterprise or your private environment URL. |
| `rainbird.knowledgeMapId` | empty | Knowledge Map ID used when no map file is open or the open file is not bound to a map. A file you open by Knowledge Map ID, save from a pull, push or bind remembers its own map, which takes precedence. When a query, pull or diff asks for an ID, the one you enter is saved here, for the folder. |
| `rainbird.useDraft` | `true` | Query the draft version of the map instead of the live version. |
| `rainbird.query.dateOrder` | `day-first` | Which reading of an ambiguous numeric date such as 01/10/1981 is offered first: `day-first` (1 October 1981) or `month-first` (10 January 1981). Ambiguous dates are never guessed: you choose one. |
| `rainbird.query.autoSkipPluralQuestions` | `injected` | When the query panel and the assistant's `run_query` tool answer *No more* for you on a plural question: `injected` when facts injected in this session cover it, `known` whenever the engine already has answers for it, `off` never. In the panel each automatic skip is shown in the transcript with *Answer instead*; `run_query` lists them under `autoSkipped`. Saved tests replay what was recorded, whatever this setting is. |
| `rainbird.query.logQuestions` | `false` | Write the raw JSON of every question the query panel receives, and each answer it sends, to the **Rainbird** output channel. Useful when an answer is rejected. |
| `rainbird.studioUrl` | empty | Rainbird Studio address for **Open in Studio** and **Copy link**. Rainbird-hosted API addresses are mapped automatically (`api.rainbird.ai` → `app.rainbird.ai`, `enterprise-api.rainbird.ai` → `enterprise.rainbird.ai`); set this only for other hosts. |
| `rainbird.ai.model` | `claude-opus-5` | Claude model used by the AI assistant (`claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-opus-4-8`; other ids can be typed into settings.json). |
| `rainbird.ai.effort` | `high` | Reasoning effort per turn: `low`, `medium`, `high`, `xhigh` or `max`. |
| `rainbird.ai.showDiffAfterEdits` | `true` | Open a before ↔ after diff automatically when a turn changed the file (direct-apply mode). |
| `rainbird.ai.applyEdits` | `immediately` | `immediately`: the assistant's edits land in the file as it works (undoable, with Show diff / Undo per turn). `preview`: edits are proposed in a diff you Accept or Reject. |

API keys are never stored in settings. Use **Rainbird: Connect** and **Rainbird: Set Anthropic API Key** to change them.

RBLang files default to a two-space indent (`editor.tabSize` 2, `editor.insertSpaces` true under `[rblang]`), which is the style Rainbird's documentation uses. VS Code's indentation detection still wins for a file that already uses tabs. To format every time you save, add to your settings:

```json
"[rblang]": {
  "editor.formatOnSave": true
}
```

## File types

| Extension | Purpose |
|---|---|
| `.rbl`, `.rblang` | RBLang knowledge maps. Full language support. |
| `.xml` | Recognised as RBLang when the file holds an `<rbl:kb>` map (the form the platform and Studio hand out). The language switches to RBLang on open, so everything above applies. Other XML files are untouched. |
| `.rbird` | Studio exports. Right-click to extract RBLang or compare against the platform. |
| `.rbtest.json` | Saved query sessions replayed by the Test Explorer. |
| `.facts.json` | Fact fixtures that can be injected into a query. |

## Known limitations

- **Push creates a new map** every time. The platform API has no update-in-place or delete, so promote changes through Studio.
- **Linked maps** are not resolved. References to symbols declared in an imported map are reported as unknown.
- **Single-file scope.** Navigation, rename and diagnostics work within the open file. There is no workspace-wide index yet.
- **The graph view is read-only.** Edit the RBLang, and the graph follows.
- **No map browser.** The Rainbird API has no endpoint that lists an account's maps, so there is no "pick a map" dialog: start from the Knowledge Map ID on the map's **Publish** page with **Open Map by Knowledge Map ID…**. The Maps view lists the maps you have opened, pushed or queried from VS Code; if the platform adds a list endpoint, the Maps view will use it.
- **Packaging to `.rbird`** is not supported. Studio's importer needs its structured model, not just the RBLang text. Use Push instead.

## Privacy

- Rainbird API keys, the evidence key and the Anthropic API key are stored in VS Code's secret storage.
- The AI assistant sends your prompts to Anthropic using your own key, together with a short context header (file name, size, cursor, diagnostic counts, connection state), the selection if any, small maps in full, and whatever the assistant reads or writes through its tools (map overview, line ranges, diagnostics, edits, query results). Nothing is sent unless you use the assistant or an AI command.
- MCP endpoint URLs are self-authenticating secrets. They are written only to your workspace's `.vscode/mcp.json` and masked on input.
- The extension reads the clipboard only when the Knowledge Map ID prompt opens, to offer an ID it finds there. Nothing is sent anywhere.

## Release notes

See the [changelog](CHANGELOG.md).

## Contributing and background

Development setup, test instructions and the product research behind this extension are in [docs/](https://github.com/RainBirdAi/rainbird-vscode/tree/main/docs).

## Licence

[MIT](LICENSE). Copyright (c) 2026 Rainbird Technologies Ltd.
