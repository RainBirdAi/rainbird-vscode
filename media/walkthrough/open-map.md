# Open your own model

Every model in Rainbird Studio has a **Knowledge Map ID** (kmID), a code such as `504436fb-7fbb-44ea-b36c-bfd977aea8c8`. It is on the model's **Publish** page, and under **View Knowledge Map ID** in the model's menu.

Run **Rae: Open Model by Knowledge Map ID…** and paste it (a copied link or Publish-page line that contains the ID works too; the prompt shows which ID it will use). The extension connects first if needed, then:

1. downloads the model's current draft as Raelog,
2. saves it as a `.rbl` file where you choose (your workspace folder by default),
3. opens it and remembers which model it belongs to, so **Run Query**, the diffs and the assistant need no ID.

The file is yours to edit. Nothing reaches Studio until you push, and **Push** creates a new model rather than updating this one. The Models view in the Rae sidebar lists the models you have opened, pushed or queried, so you can pick them again later.

There is no model browser: the Rainbird API has no endpoint that lists an account's models, so every route starts from the Knowledge Map ID. Downloading Raelog also relies on an API endpoint that is not in Rainbird's public API reference; if it fails on your environment, use one of these instead:

- **Export from Studio.** Export the model as a `.rbird` file, right-click it in the Explorer and choose **Rae: Extract Raelog from .rbird export**, then click **Bind to kmID…** to say which model it is.
- **Copy and paste.** Copy the Raelog from Studio's `</>` code panel into a new file; it is recognised as Raelog as you paste. Save it with a `.rbl` name, then run **Rae: Bind Open File to a Knowledge Map ID…**.
