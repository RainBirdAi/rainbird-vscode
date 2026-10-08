# Open your own map

Every map in Rainbird Studio has a **Knowledge Map ID** (kmID), a code such as `504436fb-7fbb-44ea-b36c-bfd977aea8c8`. It is on the map's **Publish** page, and under **View Knowledge Map ID** in the map's menu.

Run **Rainbird: Open Map by Knowledge Map ID…** and paste it (a copied link or Publish-page line that contains the ID works too; the prompt shows which ID it will use). The extension connects first if needed, then:

1. downloads the map's current draft as RBLang,
2. saves it as a `.rbl` file where you choose (your workspace folder by default),
3. opens it and remembers which map it belongs to, so **Run Query**, the diffs and the assistant need no ID.

The file is yours to edit. Nothing reaches Studio until you push, and **Push** creates a new map rather than updating this one. The Maps view in the Rainbird sidebar lists the maps you have opened, pushed or queried, so you can pick them again later.

There is no map browser: the Rainbird API has no endpoint that lists an account's maps, so every route starts from the Knowledge Map ID. Downloading RBLang also relies on an API endpoint that is not in Rainbird's public API reference; if it fails on your environment, use one of these instead:

- **Export from Studio.** Export the map as a `.rbird` file, right-click it in the Explorer and choose **Rainbird: Extract RBLang from .rbird export**, then click **Bind to kmID…** to say which map it is.
- **Copy and paste.** Copy the RBLang from Studio's `</>` code panel into a new file; it is recognised as RBLang as you paste. Save it with a `.rbl` name, then run **Rainbird: Bind Open File to a Knowledge Map ID…**.
