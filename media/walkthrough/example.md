# RBLang in VSCode

Open `examples/hello-world.rbl` to see:

- **Syntax highlighting** for RBLang elements, attributes, and the expression language inside `expression="…"` (functions, `%VARIABLES`, natural-language operators)
- **Diagnostics** for unknown elements/attributes, missing required attributes, invalid enum values, and references to undeclared concepts or relationships
- **Context-aware completions** — type `<` inside a `<relinst>` and get `condition`; type inside `rel=""` and get the relationships declared in your map
- **Hovers** on element names, expression functions and the names in your map
- **Rename everywhere** — edit a concept, relationship or instance name where it is declared and every mention follows as you type; or press `F2` on any mention
- **Snippets** — try `rule`, `fact`, `rel-questions`, `condition-count`
