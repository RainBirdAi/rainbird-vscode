# Rae by Rainbird

[![Pipeline status](https://gitlab.com/rainbird-ai/labs/rainbird-vscode/badges/main/pipeline.svg)](https://gitlab.com/rainbird-ai/labs/rainbird-vscode/-/pipelines)

Author, check, query and ship models for Rae, the decision automation platform from Rainbird, without leaving your editor.

> Commands, file formats and some platform endpoints this extension relies on may change between releases. Please report problems and ideas on [GitHub Issues](https://github.com/RainBirdAi/rainbird-vscode/issues).

Rae models are written in **Raelog**, an XML language that declares concepts, relationships, facts and rules: expertise and policy in a form a machine can reason over. The engine reasons over a model deterministically. The same model and the same inputs always give the same answer, with a certainty and an evidence tree that shows which rules fired and which facts they used. This extension turns VS Code into a first-class Raelog editor and connects it to your Rainbird environment, so you can run real queries, read the evidence behind every answer, and push models to the platform.

Raelog was previously called RBLang, and models were previously called knowledge maps. Rainbird Studio still holds your models behind the scenes, so a few steps below happen in Studio for now: finding a model's Knowledge Map ID (kmID) and API key on its **Publish** page, managing versions, enabling evidence access and exporting `.rbird` files.

## Features

### Write Raelog with confidence

- **Syntax highlighting** for elements, attributes, enum values and the expression language inside `expression="…"`, including `%VARIABLES` and natural-language operators.
- **Diagnostics as you type**, matched check by check against Studio's validator: unknown or misspelled elements and attributes, missing required attributes, invalid values, undeclared or duplicate concepts, relationships and instances, type mismatches in facts and conditions, certainty out of range, unbalanced quotes and unclosed elements, expression precedence traps, rules that can never fire, relationships that are never used, recursive rules, and more.
- **Quick fixes** on most problems: declare a missing instance, accept a did-you-mean rename, pick a valid value, add or remove attributes, delete duplicates, parenthesise an expression.
- **Completions and hovers** that know your model: child elements by context, attribute names, enum values, the concepts, relationships and instances you have declared, and every expression function with its documentation.
- **Navigation and rename**: go to definition, find references and rename for concepts, relationships and instances. Edit a name where it is declared and every mention follows as you type (linked editing, on by default for Raelog files); or press `F2` on any mention. Rename also updates quoted names inside expressions, evidence text and datasource mappings, and an instance rename stays within the instance's concept (`France` the Country, not `France` the Team). Hover a name to see what uses it.
- **Outline, breadcrumbs and folding** for the structure of the model, plus a full snippet catalogue.
- **Formatting** with **Format Document**, **Format Selection** or `editor.formatOnSave`. Each line is re-indented from the element nesting and trailing whitespace is trimmed; the file's line breaks, blank lines, comments, wrapped attributes and element order are kept as written.

### Author without memorising the syntax

- **Guided authoring**: use **Rae: Insert…** from the editor title bar, the right-click menu or the Model Explorer to add a concept, relationship, instance, fact, rule or condition by answering a few plain-English questions. Choices come from what the model already declares, and the element is inserted in the recommended section of the file.
- **CodeLens** above every relationship and rule to run it as a query or add a fact, rule or condition in place.
- **Model Explorer** in the Rae sidebar lists the concepts, relationships, rules, facts and instances of the open model. Click any item to jump to its source.
- **Graph view** shows the open model as a live, force-directed graph. Click a node or edge to jump to its line.

### Query the real engine and see the evidence

- **Run Query** opens an interactive panel: find the goal by typing part of a relationship's name, subject or object (the relationship of the rule, fact or declaration under the cursor is preselected, and the last goal for each model is remembered), give a subject, an object or both, choose draft, live or a specific version, inject facts, and answer the engine's questions. **Change…** in the panel's header points it at another model. **Back** undoes the last answer.
- **Answers in the form the engine expects.** Truth questions show True and False. Number questions have a number field with a format hint. Date questions accept dates typed naturally, such as `1 October 1981` or `1981-10-01`, or picked from a calendar, and send them as `YYYY-MM-DD`. A numeric date that could be read either way, such as `01/10/1981`, is never guessed: the card offers both readings, day first by default (`rainbird.query.dateOrder`). Options from the model appear as buttons or chips, with a filter for long lists. If the engine rejects an answer, the card keeps your answers. For a single question it says what format it expects; on a grouped card, where the engine does not say which answer failed, it asks you to fix the one in question.
- **Grouped questions** arrive on one card that works like a form: fill in every answer, then send them together with a single **Submit answers**.
- **Known answers.** Cards show what the engine already knows for a question. Plural questions with known answers offer **No more**, single-answer ones **Keep known answer**. By default the panel answers **No more** for you when the facts you injected cover every question on the card (`rainbird.query.autoSkipPluralQuestions`); on a larger card the covered questions start on **No more**. The transcript shows each automatic skip with **Answer instead**.
- **Results** show certainty bars and an inline **evidence tree** laid out like Studio's: the result as a card, each rule's conditions as rows with the source, certainty and impact of the fact behind each, a nested card where another rule inferred that fact, every fact a list function used, and an **Inputs used by this result** list. **Open in Studio** and **Copy link** open or share the same tree in Rainbird Studio (while the session lasts), and **Open in panel** gives it its own tab.
- **Show on graph** projects the inference path of a result onto the graph view.
- **Explain (AI)** under a result turns its evidence tree into a plain-English explanation. The explanation is generated from the evidence tree, never instead of it: the engine made the decision symbolically, and only the prose describing it is generated.
- **Ask in Natural Language** sends a free-text question to Rainbird's natural-language endpoint.

### Work with the platform

- **Connect** once per environment. Your API key is stored in VS Code's encrypted secret storage, never in settings files.
- **Open Model by Knowledge Map ID** downloads a model's draft and saves it as an editable `.rbl` that remembers which model it came from, so queries, diffs and the assistant need no ID. The Knowledge Map ID is on the model's **Publish** page in Studio.
- **Push Model to Platform** uploads the open file as a new model and binds the file to it. The extension lints the model first, then shows any validation message the platform returns in the Problems panel on the element it refers to.
- **Pull Model Raelog from Platform** opens the draft or any saved version of a model as read-only Raelog, for reading and diffing. **Save as .rbl…** turns it into a file bound to that model. **Reload Model from Studio**, or the cloud button on a model in the Models view, brings a bound file up to date after the model was edited in Studio.
- **Bind Open File to a Knowledge Map ID** tells the extension which model an exported or pasted file is a copy of.
- **Models view** keeps a per-environment list of the models you have opened, pushed, queried or added by ID. Open a model's current draft or run a query straight from the list. It is not a listing of your account (see Known limitations).
- **Extract Raelog from .rbird export** unpacks a Studio export into an editable `.rbl` file.
- **Add a Model's MCP Endpoint** registers a model's MCP endpoint in `.vscode/mcp.json` for use in Copilot agent mode. A Rae model can be published as a Model Context Protocol endpoint alongside its REST API, so agents can hand decisions to it.

### Compare and test

- **Side-by-side diffs** against git HEAD, the platform draft, a saved version, a Studio export, or the snapshot of the draft you last downloaded into a file or last pushed. Each comes with a **semantic report** that lists the concepts, relationships, facts and rules that were added, removed or changed, rather than line noise.
- **Promotion diff** replays a saved test or your last query session against two versions of the same model and reports every result and certainty that moved.
- **Regression tests**: save any finished query as a `.rbtest.json`. The Test Explorer replays it against the recorded target and flags certainty drift.

### AI assistant

The Rae sidebar includes an AI assistant for knowledge engineering, powered by Claude and using your own Anthropic API key. It knows Raelog and how the engine reasons in depth (a bundled reference covering concepts, relationships, rules, expressions, datasources, certainty factors and Match → Infer → Ask), and it works on the model you have open:

- **Ask about the model** — "which rules infer *has risk level*?", "why would this never ask about postcode?", "explain this rule" — and it answers from the model's actual content, naming rules and lines.
- **Ask for changes** — "add a rule that applicants over 65 skip the income check", "add question wording to every askable relationship", "fix every error" — and it edits the file through validated element-level operations (insert, replace, delete, set attribute), re-lints, fixes what it broke and summarises the change. By default edits land directly in the editor, each one undoable, with a per-turn **Changes** card offering **Show diff** and **Undo this turn**; set `rainbird.ai.applyEdits` to `preview` to review a side-by-side diff and **Accept** or **Reject** instead.
- **Start a model** from a description when no file is open.
- **Test it live** — with a connection it can push the model (always asking first), run queries against the draft, fetch evidence trees, replay saved regression tests and compare the model with git HEAD or the last pulled or pushed snapshot.

## Requirements

- VS Code 1.90 or later.
- A Rainbird account and API key for opening models from the platform, querying and pushing. The key and the Knowledge Map ID are on the model's **Publish** page in Rainbird Studio; the ID is also under **View Knowledge Map ID** in the model details menu. Editing, linting and the graph view work offline.
- An Anthropic API key if you want to use the AI assistant.
- To see evidence trees, enable the model's **Evidence Tree Link** in Studio under Publish, API Management, Access Control. **Open in Studio** works out the Studio address from `rainbird.apiUrl` for Rainbird-hosted environments; for other hosts, set `rainbird.studioUrl`.

## Getting started

1. Install **Rae by Rainbird** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=RainbirdTechnologies.rainbird), or from the Extensions view in VS Code, or from a terminal:

   ```bash
   code --install-extension RainbirdTechnologies.rainbird
   ```

2. Run **Rae: Connect**, pick Community, Enterprise or a custom URL, and paste the API key from your model's **Publish** page in Rainbird Studio.
3. Run **Rae: Open Model by Knowledge Map ID…**, paste the model's Knowledge Map ID, which is on the same page, and choose where to save the `.rbl` (your open folder by default): it opens bound to that model. Two other routes work too: export a `.rbird` from Studio and right-click it to **Extract Raelog**, or paste the Raelog from Studio's `</>` code panel into a new file. To look around without an account, run **Help: Get Started**, choose **Get started with Rae** and click **Open example**; you can explore the example model offline, but it must be pushed to your account before it can be queried.
4. Click the play button in the editor title bar, or run **Rae: Run Query…**. Type part of the goal relationship's name and pick it, give a subject or an object, and click **Start query**. Answer the questions, then click **Show evidence** under the result. For an exported or pasted file, run **Rae: Bind Open File to a Knowledge Map ID…** first, or enter the ID when prompted (it becomes the folder's default model).
5. Optional: open the **Rae** icon in the activity bar, choose **AI Assistant** and paste an Anthropic API key when prompted.

## Commands

All commands are available from the Command Palette. The most used ones:

| Command | What it does |
|---|---|
| Rae: Connect | Choose an environment and store an API key |
| Rae: Open Model by Knowledge Map ID… | Download a model's draft by its Knowledge Map ID and save it as an editable `.rbl` bound to that model |
| Rae: Run Query… | Open the interactive query panel for the open model |
| Rae: Show Graph View | Show the open model as a live graph |
| Rae: Insert… | Guided authoring of a concept, relationship, instance, fact, rule or condition |
| Rae: Push Model to Platform | Upload the open file as a new model and bind the file to it |
| Rae: Pull Model Raelog from Platform (read-only draft or saved version)… | Open the draft or a saved version read-only, with **Save as .rbl…** |
| Rae: Reload Model from Studio | Replace the open, bound file with the model's current draft (warns first if you changed the file) |
| Rae: Get Started | Open the getting-started walkthrough |
| Rae: Bind Open File to a Knowledge Map ID… | Tell the extension which model the open file is a copy of |
| Rae: Diff vs git HEAD… | Side-by-side diff with a semantic report |
| Rae: Diff Open File Against Platform Draft | Check whether your file matches the platform draft |
| Rae: Diff Against Last Pulled or Pushed Snapshot | Side-by-side diff with the draft you last downloaded into a file, or what you last pushed, for this file's model |
| Rae: Compare Draft vs Saved Version… | Compare the platform draft with a saved version or an export |
| Rae: Compare Versions (Promotion Diff)… | Replay a test or session against two versions |
| Rae: Ask in Natural Language (beta)… | Free-text question against the engine |
| Rae: Explain with AI | Plain-English explanation of the selected Raelog, from the AI assistant (for a query result, use **Explain (AI)** in the query panel) |
| Rae: Show Evidence Tree for Fact… | Open the evidence tree for a session and fact ID in its own tab |
| Rae: Extract Raelog from .rbird export | Convert a Studio export to `.rbl` |
| Rae: Add a Model's MCP Endpoint… | Register a model's MCP endpoint in `.vscode/mcp.json` |
| Rae: Set Anthropic API Key | Store the key used by the AI assistant |
| Rae: Set Evidence Key | Store the evidence key a model requires for evidence trees |

## Settings

| Setting | Default | Description |
|---|---|---|
| `rainbird.apiUrl` | `https://api.rainbird.ai` | API base URL. Use `https://enterprise-api.rainbird.ai` for Enterprise or your private environment URL. |
| `rainbird.knowledgeMapId` | empty | Knowledge Map ID used when no model file is open or the open file is not bound to a model. A file you open by Knowledge Map ID, save from a pull, push or bind remembers its own model, which takes precedence. When a query, pull or diff asks for an ID, the one you enter is saved here, for the folder. |
| `rainbird.useDraft` | `true` | Query the draft version of the model instead of the live version. |
| `rainbird.query.dateOrder` | `day-first` | Which reading of an ambiguous numeric date such as 01/10/1981 is offered first: `day-first` (1 October 1981) or `month-first` (10 January 1981). Ambiguous dates are never guessed: you choose one. |
| `rainbird.query.autoSkipPluralQuestions` | `injected` | When the query panel and the assistant's `run_query` tool answer *No more* for you on a plural question: `injected` when facts injected in this session cover it, `known` whenever the engine already has answers for it, `off` never. In the panel each automatic skip is shown in the transcript with *Answer instead*; `run_query` lists them under `autoSkipped`. Saved tests replay what was recorded, whatever this setting is. |
| `rainbird.query.logQuestions` | `false` | Write the raw JSON of every question the query panel receives, and each answer it sends, to the **Rae** output channel. Useful when an answer is rejected. |
| `rainbird.studioUrl` | empty | Rainbird Studio address for **Open in Studio** and **Copy link**. Rainbird-hosted API addresses are mapped automatically (`api.rainbird.ai` → `app.rainbird.ai`, `enterprise-api.rainbird.ai` → `enterprise.rainbird.ai`); set this only for other hosts. |
| `rainbird.ai.model` | `claude-opus-5` | Claude model used by the AI assistant (`claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-opus-4-8`; other ids can be typed into settings.json). |
| `rainbird.ai.effort` | `high` | Reasoning effort per turn: `low`, `medium`, `high`, `xhigh` or `max`. |
| `rainbird.ai.showDiffAfterEdits` | `true` | Open a before ↔ after diff automatically when a turn changed the file (direct-apply mode). |
| `rainbird.ai.applyEdits` | `immediately` | `immediately`: the assistant's edits land in the file as it works (undoable, with Show diff / Undo per turn). `preview`: edits are proposed in a diff you Accept or Reject. |

API keys are never stored in settings. Use **Rae: Connect** and **Rae: Set Anthropic API Key** to change them.

Raelog files default to a two-space indent (`editor.tabSize` 2, `editor.insertSpaces` true under `[rblang]`), which is the style Rainbird's documentation uses. VS Code's indentation detection still wins for a file that already uses tabs. To format every time you save, add to your settings:

```json
"[rblang]": {
  "editor.formatOnSave": true
}
```

## File types

| Extension | Purpose |
|---|---|
| `.rbl`, `.raelog`, `.rblang` | Raelog models. Full language support. New files are saved as `.rbl`. |
| `.xml` | Recognised as Raelog when the file holds an `<rbl:kb>` model (the form the platform and Studio hand out). The language switches to Raelog on open, so everything above applies. Other XML files are untouched. |
| `.rbird` | Studio exports. Right-click to extract Raelog or compare against the platform. |
| `.rbtest.json` | Saved query sessions replayed by the Test Explorer. |
| `.facts.json` | Fact fixtures that can be injected into a query. |

## Known limitations

- **Push creates a new model** every time. The platform API has no update-in-place or delete, so promote changes through Studio.
- **Linked models** are not resolved. References to symbols declared in an imported model are reported as unknown.
- **Single-file scope.** Navigation, rename and diagnostics work within the open file. There is no workspace-wide index yet.
- **The graph view is read-only.** Edit the Raelog, and the graph follows.
- **No model browser.** The Rainbird API has no endpoint that lists an account's models, so there is no "pick a model" dialog: start from the Knowledge Map ID on the model's **Publish** page with **Open Model by Knowledge Map ID…**. The Models view lists the models you have opened, pushed or queried from VS Code; if the platform adds a list endpoint, the Models view will use it.
- **Packaging to `.rbird`** is not supported. Studio's importer needs its own structured form of the model, not just the Raelog text. Use Push instead.

## Privacy

- Rainbird API keys, the evidence key and the Anthropic API key are stored in VS Code's secret storage.
- The AI assistant sends your prompts to Anthropic using your own key, together with a short context header (file name, size, cursor, diagnostic counts, connection state), the selection if any, small models in full, and whatever the assistant reads or writes through its tools (model overview, line ranges, diagnostics, edits, query results). Nothing is sent unless you use the assistant or an AI command.
- MCP endpoint URLs are self-authenticating secrets. They are written only to your workspace's `.vscode/mcp.json` and masked on input.
- The extension reads the clipboard only when the Knowledge Map ID prompt opens, to offer an ID it finds there. Nothing is sent anywhere.

## Release notes

See the [changelog](CHANGELOG.md).

## Contributing and background

Development setup, test instructions and the product research behind this extension are in [docs/](https://github.com/RainBirdAi/rainbird-vscode/tree/main/docs).

## Licence

[MIT](LICENSE). Copyright (c) 2026 Rainbird Technologies Ltd.
