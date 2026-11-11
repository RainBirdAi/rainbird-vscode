# Raelog in VS Code

Raelog is the language models are written in for Rae, the decision automation platform from Rainbird. Open `examples/hello-world.raelog` to see:

- **Syntax highlighting** for Raelog elements, attributes, and the expression language inside `expression="…"` (functions, `%VARIABLES`, natural-language operators)
- **Diagnostics** for unknown elements/attributes, missing required attributes, invalid enum values, and references to undeclared concepts or relationships
- **Context-aware completions** — type `<` inside a `<relinst>` and get `condition`; type inside `rel=""` and get the relationships declared in your model
- **Hovers** on element names, expression functions and the names in your model
- **Rename everywhere** — edit a concept, relationship or instance name where it is declared and every mention follows as you type; or press `F2` on any mention
- **Snippets** — try `rule`, `fact`, `rel-questions`, `condition-count`

The example works offline and needs no account. It is not one of your Rae models, though: to query it, push it first (cloud icon in the editor title bar; every push creates a new model), or open one of your own models in the next steps.

You can also open any `.raelog` model, such as the examples on [raelog.ai](https://raelog.ai).
