# Getting started with Rainbird for VS Code

This guide is for anyone at Rainbird who wants to try the VS Code extension, whether or not you write code every day. It takes about ten minutes to go from nothing installed to running your first query.

## What it is

Rainbird for VS Code turns Visual Studio Code into an editor for knowledge maps. A map is written in RBLang, the XML-based language that declares concepts, relationships, facts and rules. With the extension installed you can write and check RBLang, see the map as a graph, run real queries against your Rainbird environment, read the evidence behind every answer, save queries as tests, and push maps to the platform. An AI assistant can read, explain and edit the map with you.

The extension is in beta. Commands and file formats may change between releases.

## Before you start

You need:

- **VS Code 1.90 or later.** Download it from [code.visualstudio.com](https://code.visualstudio.com/) if you do not have it.
- **A Rainbird API key**, only if you want to run queries or push maps. Open your map in Rainbird Studio, go to the **Publish** page, and copy the API key and the Knowledge Map ID. Editing, linting and the graph view work without a key.
- **An Anthropic API key**, only if you want to use the AI assistant.
- **Evidence Tree Link enabled** on the map, if you want to see evidence trees. In Studio this is under Publish, then API Management, then Access Control.

## Install

Pick whichever is easiest:

- In VS Code, open the Extensions view (the four-squares icon in the left bar, or `Cmd+Shift+X` on Mac, `Ctrl+Shift+X` on Windows), search for **Rainbird** and click **Install**.
- Or open the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=RainbirdTechnologies.rainbird) and click **Install**.
- Or from a terminal:

  ```bash
  code --install-extension RainbirdTechnologies.rainbird
  ```

## First run, step by step

All commands below are run from the Command Palette. Open it with `Cmd+Shift+P` on Mac or `Ctrl+Shift+P` on Windows, then start typing the command name.

1. **Open a map.** Open any `.rbl` file, or run **Help: Get Started** and choose **Get started with Rainbird**. The walkthrough opens an example map and takes you through the basics in three steps.

2. **Connect to your environment.** Run **Rainbird: Connect**. Choose Community, Enterprise or a custom URL, then paste your API key. The key is stored in VS Code's encrypted secret storage, never in a settings file. You do this once per environment.

3. **Run your first query.** Click the play button at the top right of the editor, or run **Rainbird: Run Query…**. Enter the Knowledge Map ID when asked. The query panel opens: pick a goal, answer the engine's questions as they appear, and expand the evidence tree under each result to see how the answer was reached.

4. **Optional: switch on the AI assistant.** Click the Rainbird icon in the left activity bar, open **AI Assistant**, and paste your Anthropic API key when prompted. You can change it later with **Rainbird: Set Anthropic API Key (AI assistant)**.

That is the whole setup.

## What it does

### Writing RBLang

Open a `.rbl` file and the editor does the following without any setup:

- **Highlights the syntax**, including the expression language inside `expression="…"`.
- **Checks the map as you type.** Problems appear underlined and in the Problems panel, matched check by check against Studio's validator: misspelled elements, missing attributes, undeclared concepts, type mismatches, rules that can never fire, unused relationships, and more.
- **Offers quick fixes.** Click the lightbulb on a problem to declare a missing instance, accept a did-you-mean rename, pick a valid value or remove a duplicate.
- **Completes and explains.** Suggestions are drawn from your map: concepts, relationships, instances and every expression function with its documentation. Hover any name to see what uses it.
- **Renames safely.** Edit a name where it is declared and every mention follows as you type. Or press `F2` on any mention.
- **Formats the file.** Use **Format Document** to re-indent. Line breaks, comments and element order are kept.

You do not have to remember the syntax. Run **Rainbird: Insert…** from the editor title bar or the right-click menu to add a concept, relationship, instance, fact, rule or condition by answering a few plain-English questions.

### Seeing the map

- **Map Explorer** in the Rainbird sidebar lists everything the open map declares. Click an item to jump to it.
- **Rainbird: Show Graph View** shows the map as a live graph that updates as you type. Click a node or edge to jump to its line.

### Querying and reading evidence

The query panel lets you:

- Run against the **draft**, the **live** version or a specific saved version.
- **Inject facts** before starting.
- Answer questions as cards with yes/no buttons, option chips, sliders or free text. **Undo** steps back a question.
- Read **certainty bars** and an inline **evidence tree** for every result.
- Click **Show on graph** to see the inference path drawn on the graph view.
- Click **Explain with AI** for a plain-English account of why the engine decided what it did.

### Testing and comparing

- **Save a query as a test.** When a query finishes, save it as a `.rbtest.json` file. VS Code's Test Explorer replays it and flags any result whose certainty has drifted.
- **Promotion diff.** Run **Rainbird: Compare Versions (Promotion Diff)…** to replay a test against two versions of the map and see every result that moved.
- **Semantic diffs.** Compare your file against git, the platform draft, a saved version or the last snapshot you pushed. Each diff comes with a report listing the concepts, relationships, facts and rules that changed, rather than raw line changes.

### Working with the platform

- **Rainbird: Push Map to Platform** lints the map, uploads it as a **new** map, and shows any platform validation messages on the lines they refer to. It does not overwrite an existing map.
- **Rainbird: Pull Map RBLang from Platform…** opens the draft or a saved version as read-only RBLang.
- **Rainbird: Extract RBLang from .rbird export** unpacks a Studio export into an editable file.
- The **Maps** view remembers the maps you have pushed, queried or added by ID, per environment.

### The AI assistant

The assistant works on the map you have open. It knows RBLang in depth: the language reference, the certainty model, the validation checklist and common mistakes are built in. You can:

- **Ask about the map.** "Which rules infer *has risk level*?" "Why would this never ask about postcode?" It answers from the actual content, naming rules and lines.
- **Ask for changes.** "Add a rule that applicants over 65 skip the income check." "Fix every error." It edits the file through validated element-level operations, re-lints, and summarises what it did. Every edit is undoable. Each turn shows a **Changes** card with **Show diff** and **Undo this turn**.
- **Start a map from a description** when no file is open.
- **Test it live.** With a connection it can push the map (it always asks first), run queries, fetch evidence trees, replay saved tests and compare versions.

If you would rather review each change before it lands, set `rainbird.ai.applyEdits` to `preview` in Settings. You then get a side-by-side diff with **Accept** and **Reject**.

## Good to know

- **Cost.** The assistant uses your own Anthropic key, so usage is billed to you. The `rainbird.ai.model` and `rainbird.ai.effort` settings trade speed and cost against quality.
- **Privacy.** Nothing is sent to Anthropic unless you use the assistant or an AI command. When you do, it sends your prompt, a short context header, the selection if any, small maps in full, and whatever it reads or writes through its tools.
- **Push creates a new map every time.** There is no update-in-place yet.
- **One file at a time.** The extension works on the open file. Linked maps are not resolved.
- **The graph view is read-only.**

## Where to get help

- The full feature list and settings reference are in the extension's [README](../README.md).
- Release notes are in the [changelog](../CHANGELOG.md).
- Report problems or ideas on the project's issue tracker, or ask in the team's Slack channel.
