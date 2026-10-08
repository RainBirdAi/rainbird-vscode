# Getting started with Rainbird for VS Code

This guide is for anyone at Rainbird who wants to try the VS Code extension, whether or not you write code every day. It takes about ten minutes to go from nothing installed to running your first query.

## What it is

Rainbird for VS Code turns Visual Studio Code into an editor for knowledge maps. A map is written in RBLang, the XML-based language that declares concepts, relationships, facts and rules. With the extension installed you can open your Studio maps by their Knowledge Map ID, write and check RBLang, see the map as a graph, run real queries against your Rainbird environment, read the evidence behind every answer, save queries as tests, and push maps to the platform. An AI assistant can read, explain and edit the map with you.

The extension is in beta. Commands and file formats may change between releases.

## Before you start

You need:

- **VS Code 1.90 or later.** Download it from [code.visualstudio.com](https://code.visualstudio.com/) if you do not have it.
- **A Rainbird API key**, only if you want to open maps from the platform, run queries or push maps. Editing, linting and the graph view work without one.
- **Your map's Knowledge Map ID (kmID).** Open the map in Rainbird Studio and go to its **Publish** page: the Knowledge Map ID (a long code such as `504436fb-7fbb-44ea-b36c-bfd977aea8c8`) and the API key are both shown there. The ID is also under **View Knowledge Map ID** in the map details menu. Keep the Publish page open; you will copy from it twice.
- **An Anthropic API key (Optional)**, only if you want to use the AI assistant.
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

**First, open a folder.** Use **File > Open Folder…** and pick or create a folder for your maps. Maps you download from the platform are saved there, and the extension remembers each file's Knowledge Map ID with it. (Everything works without a folder too, but you will be asked for the ID more often.)

1. **Connect to your environment.** Run **Rainbird: Connect**. Choose Community (Studio at `app.rainbird.ai`), Enterprise (Studio at `enterprise.rainbird.ai`) or a custom URL, then paste the API key from the map's Publish page. The key is stored in VS Code's encrypted secret storage, never in a settings file. You do this once per environment.

2. **Get one of your maps into VS Code.** There is no command that lists your Studio maps: the Rainbird API has no way to list an account's maps, so every route starts from the map's Knowledge Map ID. Pick one:

   - **Recommended: open it by its Knowledge Map ID.** Run **Rainbird: Open Map by Knowledge Map ID…**, paste the Knowledge Map ID and choose where to save. The extension downloads the map's current draft as RBLang, saves it as a `.rbl` file in your folder, opens it and remembers which map it came from, so the next step asks for nothing. If the Maps view already lists maps, the prompt shows them under **Maps**: pick one, or paste the new ID straight into the box. If you have just copied an ID, the prompt offers it.
   - **Or export from Studio.** In Studio, open the map, click its name and choose **Export**; you get a `.rbird` file (see Rainbird's docs, [Import & export knowledge maps](https://docs.rainbird.ai/rainbird/knowledge-modelling/modelling-features/other-features/import-export-knowledge-maps)). In VS Code, right-click the `.rbird` in the Explorer and choose **Rainbird: Extract RBLang from .rbird export**; an editable `.rbl` appears next to it. The export does not carry the Knowledge Map ID, so the extension then offers **Bind to kmID…**: paste the ID there to give the file its own map. If you choose **Later**, run **Rainbird: Bind Open File to a Knowledge Map ID…** before you query it. Use this route when you want an offline copy or do not have an API key. It is also the fallback if downloading by ID ever stops working, since the download uses a platform endpoint that is not in Rainbird's public API documentation.
   - **Or copy and paste.** In Studio, open the **`</>`** code panel, select all and copy. In VS Code choose **File > New Text File** and paste. The extension starts with VS Code, so in any window it recognises RBLang as you paste and switches on highlighting and checks. Then use **File > Save As…** with a `.rbl` name. Fine for a quick look; like the export, the file has no Knowledge Map ID until you run **Rainbird: Bind Open File to a Knowledge Map ID…**.

   Whichever route you take you end up with an ordinary `.rbl` file on disk. Edit it like any file; nothing reaches Studio until you push (see *Working with the platform*).

3. **Run your first query.** Click the play button at the top right of the editor, or run **Rainbird: Run Query…**. If the file is not bound to a map, paste the Knowledge Map ID when asked. It becomes this folder's default map (`rainbird.knowledgeMapId`), used for every file in the folder that is not bound to a map; if you work on several maps, bind each file instead. The query panel opens. Start typing in **Goal relationship** to search your map's relationships by name, subject or object (if your cursor was in a relationship's declaration, a rule or a fact, its relationship is already filled in; in a rule, conditions included, that is the relationship the rule infers), give a subject, an object or both, click **Start query**, answer the engine's questions as they appear, and click **Show evidence** under each result to see how the answer was reached. You can also query a map you have not downloaded: run **Rainbird: Run Query…** with no file open and the goals are read from the platform draft.

4. **Optional: switch on the AI assistant.** Click the Rainbird icon in the left activity bar, open **AI Assistant**, and paste your Anthropic API key when prompted. You can change it later with **Rainbird: Set Anthropic API Key (AI assistant)**.

**Just looking?** Run **Rainbird: Get Started** and click **Open example**. A small sample map opens with no account needed, and you can try editing, the checks, the Map Explorer and the graph view offline. The example is not on your Rainbird account, so it cannot be queried as it is: push it first with **Rainbird: Push Map to Platform**, which creates a copy on your account, or open one of your own maps instead.

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

- **Find the goal by typing.** Type part of a relationship's name, its subject or its object in **Goal relationship**, then pick from the list with the arrow keys and Enter, or click it. Each entry shows what the relationship links, whether it is plural, how many rules infer it and how many facts the map holds for it. An `askable="none"` relationship with no rules or facts is flagged: the engine cannot answer it without injected facts. Names are case-sensitive: if your spelling differs from the map's only in case, a hint says so and the query uses the map's spelling. Start from the editor's play button with the cursor in a relationship's declaration, a rule or a fact, and its relationship is filled in for you (in a rule, conditions included, the relationship the rule infers). The last goal you ran against each map is remembered. Enter starts the query once the goal is one of the map's relationships; to send another name, click **Start query**.
- Run against the **draft**, the **live** version or a specific saved version.
- **See or change the map.** The header shows the map the panel queries. **Change…** beside it points the panel at another map. Opened from a `.rbl`, it binds that file to another Knowledge Map ID: it runs **Rainbird: Bind Open File to a Knowledge Map ID…**, so the file's queries, diffs and assistant use that map from then on. With no file, or for a read-only platform draft or snapshot, it asks for a Knowledge Map ID and queries that map. Until the panel has a map, the button reads **Choose map…**.
- **Inject facts** before starting, as JSON or CSV or from a `.facts.json` file. The engine treats them like answers it already has. Plural relationships, and facts injected below 100% certainty, are exceptions; see *Good to know*. If the engine rejects the facts, or the query cannot start for another reason (an unknown goal or Knowledge Map ID, no live version, or no such version), the setup card comes back with everything you entered and the reason under it.
- **Answer questions on cards made for the type of answer.**
  - Yes/no questions have **Yes** and **No** buttons; truth questions have **True** and **False**.
  - A number question has a number field. The hint under it says what is accepted: digits and a decimal point, no units or thousands separators.
  - A date question takes a date typed naturally, such as `1 October 1981`, `1 Oct 1981` or `1981-10-01`, or picked from the calendar beside the field. The card shows the date it will send as `YYYY-MM-DD`, which is the format the engine accepts. A date that could be read either way, such as `01/10/1981`, is never guessed: the card offers both readings, day first by default; set `rainbird.query.dateOrder` to `month-first` to list 10 January 1981 first. For number and date questions, values the map suggests appear under the field as **Suggestions:** chips that fill it in.
  - Options from the map appear as buttons or chips, with a filter box when there are many, and an **Or something else** field when the map allows new values.
  - **Don't know** appears when the map allows a question to be skipped (`allowUnknown`). **Back** steps back a question.
- **Answer grouped questions together.** Questions the map groups arrive on one card. Fill in every answer, then click **Submit answers** once. Enter in a text field moves to the next unanswered question, or submits when none is left. Anything still missing is highlighted.
- **Fix a rejected answer.** If the engine rejects an answer, the card keeps your answers. For a single question it says what format it expects; on a grouped card, where the engine does not say which answer failed, it asks you to fix the one in question. If Rainbird does not reply to an answer, to **Back** or to an automatic **No more**, the card or the result comes back with your answers kept and a note, so you can send it again.
- **See what the engine already knows.** A card lists the values the engine already has for the question under **Already known**, and marks the ones that came from your injected facts. A plural question with known answers has a **No more** button, which tells the engine there is nothing to add. By default the panel answers **No more** for you when the facts you injected already cover a plural question (for a card with several questions, when they cover every one; otherwise the covered ones start on **No more**). Each automatic **No more** appears in the transcript with an **Answer instead** link that brings the question back while it is still the last step. The setting `rainbird.query.autoSkipPluralQuestions` changes this: `off` always asks, and `known` also skips when the known answers came from the map, a datasource or a rule.
- Read **certainty bars** and an inline **evidence tree** for every result.
- Click **Show on graph** to see the inference path drawn on the graph view.
- Click **Explain (AI)** under a result for a plain-English account of why the engine decided what it did.

**Reading an evidence tree.** Click **Show evidence** under a result. The tree is laid out like Studio's:

- The result is the top card, with a coloured badge for its source (rule, answer, injected, datasource or knowledge map), its certainty, and its subject, relationship and object. The legend above the tree explains the colours.
- A rule card lists its conditions in the order the engine reports them, one row each: the fact that satisfied the condition, with its source badge and certainty, and a bar for its impact. The grey part of the bar is the most that condition could have contributed. An expression condition shows its text with ✓ or ✗ in place of a fact. When another rule inferred the fact, that rule's card is nested under the row, collapsed.
- A list function such as `sumObjects(%S, 'has income', *)` shows the call, its result and each fact it used.
- An optional condition that was not met is struck through and shows 0%. Conditions with zero weight are listed separately, under **Zero salience conditions**.
- **Inputs used by this result**, at the bottom, lists every answer, injected fact, datasource fact and map fact behind the result.
- **Expand all** and **Collapse all** help with big trees. **Open in panel** opens the tree in its own tab. **Open in Studio** and **Copy link** open or share the same tree in Rainbird Studio; the link opens only while the query session still exists, and only when the map's Evidence Tree Link is on, so share it soon.
- If the tree is locked, the card says how to unlock it: turn on **Evidence Tree Link** in Studio and click **Retry**, or click **Set evidence key…** and paste the map's evidence key (the tree loads again once the key has changed).
- **Show evidence** becomes **Hide evidence**, and a loaded tree is kept, so showing it again is instant. If some facts could not be loaded, the tree says so and offers **Retry**. If the session has expired, the card says to start a **New query**. A failed **Explain (AI)** can be clicked again.

### Testing and comparing

- **Save a query as a test.** When a query finishes, save it as a `.rbtest.json` file. VS Code's Test Explorer replays it and flags any result whose certainty has drifted.
- **Promotion diff.** Run **Rainbird: Compare Versions (Promotion Diff)…** to replay a test against two versions of the map and see every result that moved.
- **Semantic diffs.** Compare your file against git, the platform draft, a saved version, or the snapshot of the draft you last downloaded into a file or last pushed (**Rainbird: Diff Against Last Pulled or Pushed Snapshot**). Each diff comes with a report listing the concepts, relationships, facts and rules that changed, rather than raw line changes. For a file you opened by its Knowledge Map ID or pushed, the gutter bars in the editor show what you have changed since.

### Working with the platform

- **Rainbird: Open Map by Knowledge Map ID…** downloads a map's draft into an editable `.rbl` bound to that map (step 2 above).
- **Rainbird: Bind Open File to a Knowledge Map ID…** tells the extension which map the open file is a copy of: use it for an exported or pasted map, or to point a file at a different map. Queries, diffs and the assistant then use that map.
- **Rainbird: Push Map to Platform** lints the map, uploads it as a **new** map, binds the open file to the new map and shows any platform validation messages on the lines they refer to. It does not overwrite an existing map.
- **Rainbird: Pull Map RBLang from Platform (read-only draft or saved version)…** opens the draft or any saved version as a read-only document for reading and diffing; **Save as .rbl…** turns it into a file bound to that map.
- **Rainbird: Reload Map from Studio** refreshes a file you opened by Knowledge Map ID (or pulled, pushed or bound) with what the map's draft holds now, after you have edited the map in Studio. If you also changed the file, you are warned first and can look at the differences; the reload can be undone in the editor. It is in the editor's right-click menu too, and each map in the **Maps** view has a **Reload from Studio** button (the cloud icon) that reloads that map's file.
- **Rainbird: Extract RBLang from .rbird export** unpacks a Studio export into an editable file.
- The **Maps** view lists the maps you have opened, pushed or queried from VS Code on the current environment. It is not a list of your Studio account: the API has no endpoint for that. Click a map to read its current draft; use the play icon to query it.

### The AI assistant

The assistant works on the map you have open. It knows RBLang in depth: the language reference, the certainty model, the validation checklist and common mistakes are built in. You can:

- **Ask about the map.** "Which rules infer *has risk level*?" "Why would this never ask about postcode?" It answers from the actual content, naming rules and lines.
- **Ask for changes.** "Add a rule that applicants over 65 skip the income check." "Fix every error." It edits the file through validated element-level operations, re-lints, and summarises what it did. Every edit is undoable. Each turn shows a **Changes** card with **Show diff** and **Undo this turn**.
- **Start a map from a description** when no file is open.
- **Test it live.** With a connection it can push the map (it always asks first), run queries, fetch evidence trees, replay saved tests and compare versions.

If you would rather review each change before it lands, set `rainbird.ai.applyEdits` to `preview` in Settings. You then get a side-by-side diff with **Accept** and **Reject**.

## Good to know

- **No map browser.** The Rainbird API has no endpoint that lists an account's maps, so there is no "pick a map" dialog. Every route starts from a Knowledge Map ID, copied from the map's Publish page in Studio or from **View Knowledge Map ID** in the map details menu. A list endpoint has been requested from the platform team; the Maps view will use it when it exists.
- **Plural relationships are asked by design.** A plural relationship (one subject, many objects) is still asked when facts for it were injected, so that more can be added. The query panel shows what is already known and, by default, answers **No more** for you when your injected facts cover the question. To stop the engine asking at all, set `askable="none"` on the relationship in the map. If the engine refuses a skip and the panel's `.rbl`, or another `.rbl` open in an editor, declares the relationship, the card offers **Make “\<relationship>” inject-only…**, which sets it for you after asking: the file is changed but not saved, and pushing it creates a new map. Only do that if every session injects those facts: otherwise rules that need them get no result.
- **An injected fact below 100% certainty may be asked again.** The engine can ask the question again for a fact you injected with a certainty below 100. The card shows the injected value under **Already known**, and **Keep known answer** keeps it. Verified on Rainbird's public HelloWorld map: with `Tom lives in France` injected at 90%, the engine still asked where Tom lives; at 100% it did not.
- **Names must match exactly.** Relationship and instance names in injected facts must match the map exactly, case included. A mismatch is either rejected by the engine or attaches to nothing. When an injected subject or object differs from the question's only in case, such as `fred` for `Fred`, the question card points it out.
- **Cost.** The assistant uses your own Anthropic key, so usage is billed to you. The `rainbird.ai.model` and `rainbird.ai.effort` settings trade speed and cost against quality.
- **Privacy.** Nothing is sent to Anthropic unless you use the assistant or an AI command. When you do, it sends your prompt, a short context header, the selection if any, small maps in full, and whatever it reads or writes through its tools. The Knowledge Map ID prompt reads your clipboard only when it opens, to offer an ID it finds there.
- **Push creates a new map every time.** There is no update-in-place yet, even for a map you opened by its Knowledge Map ID, and after a push the file is bound to the new map, so queries, gutter bars and diffs use the copy. To change the original, paste your edits into its `</>` code panel in Studio; to point the file back at it, run **Rainbird: Bind Open File to a Knowledge Map ID…**.
- **One file at a time.** The extension works on the open file. Linked maps are not resolved.
- **The graph view is read-only.**

## Where to get help

- The full feature list and settings reference are in the extension's [README](../README.md).
- Release notes are in the [changelog](../CHANGELOG.md).
- Report problems or ideas on the project's issue tracker, or ask in the team's Slack channel.
