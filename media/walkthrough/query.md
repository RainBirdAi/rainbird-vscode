# Run a query

Switch to the `.rbl` you opened in the previous step and click ▶ in its title bar, or run **Rainbird: Run Query…** from the Command Palette. The file knows which map it belongs to, so there is nothing to type.

1. **Pick a goal.** Type part of a relationship's name, subject or object to search the list; the relationship of the rule, fact or declaration under your cursor is preselected. Give a subject, an object or both, then click **Start query**. Wrong map? Click **Change…** in the panel's header.
2. **Answer the questions** the engine asks. Each card has the control the question needs: True / False, a number field, a date field that takes `1981-10-01` or `1 October 1981` (an ambiguous `01/10/1981` asks which you mean, day first by default — `rainbird.query.dateOrder`), or the map's options. Related questions arrive together on one card and go back with a single **Submit answers**.
3. **Already known** lists what the engine already knows for a question, such as facts you injected. Plural relationships are asked anyway, by design, so you can add more: click **No more** when you are done. By default the extension answers it for you when facts you injected cover the question, and the transcript shows that with **Answer instead** (`rainbird.query.autoSkipPluralQuestions`).
4. **Read the result** with its certainty, then click **Show evidence**: the rule's conditions, the facts behind each one, and **Inputs used**, the facts the result rests on. **Open in Studio** shows the same tree in Rainbird Studio.

No `.rbl` open? **Run Query…** still works: it uses the workspace's default map (`rainbird.knowledgeMapId`) or asks which map, and reads the goals from the platform draft.

The evidence tree needs the map's **Evidence Tree Link** enabled (Studio → Publish → API Management → Access Control). If the tree is locked, use **Set evidence key…** on the card, or enable Evidence Tree Link in Studio and click **Retry**.

The example map from the first step is not on your Rainbird account: push it (cloud icon) or open one of your own maps before querying.
