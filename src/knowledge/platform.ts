/**
 * Knowledge reference, part 1: what Rainbird is. Written for the assistant's
 * system prompt so it can answer product questions and reason about where a
 * knowledge map sits in the platform (draft, versions, sessions, evidence).
 * Clean-room prose derived from Rainbird's public documentation.
 */

export const PLATFORM_SECTION = `## 1. What Rainbird and Rae are

Rainbird is the company. **Rae** is the decision automation platform from Rainbird (open beta from 9 November 2026). Domain expertise is encoded as a **model**, written in **Raelog**, and the engine (**Rae Reasoner**) reasons over it deterministically: the same model and inputs always give the same answer, with a certainty score and an evidence tree for every answer. There is no generative step in the decision path; language models are used only around the edges (authoring, natural-language front ends, explanations).

Building blocks of a model:
- **Concepts** — typed containers of things (Person, Country, Age). Types: string, number, date, truth.
- **Relationships** — directional links from a subject concept to an object concept ("Person speaks Language"). They can be singular or plural, and can be *askable*, meaning the engine may ask a user for the missing value.
- **Facts** — subject → relationship → object triples with a certainty from 0 to 100 ("Julio lives in France, cf 100"). Facts come from the model itself, from injection via API, from a user's answer, from a datasource, or from a rule.
- **Rules** — conditions over relationships and expressions that let the engine infer new facts. A rule's header names the relationship it infers and caps the certainty of anything it produces.
- **Datasources** — REST calls the engine makes mid-inference to fetch facts from external APIs.

Tooling and lifecycle:
- **The Rae app** (app.raelog.ai) is where users build and manage models as projects. A project's **Connect** section has an **API** tab (the kmID of the version it serves, and the calls to make) and an **MCP** tab (the model's MCP endpoint URL). The Platform API key is entered in Rae's Settings → API keys and comes from the user's account page in Rainbird Studio. raelog.ai explains the product, the docs are at docs.raelog.ai, and models can be downloaded as \`.raelog\` files (plain Raelog).
- **RAKE** is Rae's agentic knowledge engineer: it builds models from knowledge sources and a brief.
- **Rainbird Studio** is the legacy web authoring environment (Community at app.rainbird.ai, Enterprise at enterprise.rainbird.ai). It still holds models in the background, and today it is where the Publish page, versions, set live, evidence access (Evidence Tree Link) and \`.rbird\` exports live. Its visual graph editor and its \`</>\` code panel (showing the Raelog) are two views of the same model, and it auto-saves to the model's single editable **draft**.
- Every model has a **kmID**: its Knowledge Map ID, shown on the project's **Connect → API** tab in Rae (each version of a Rae project has its own kmID) and on the model's Publish page in Studio. **Publishing** creates an immutable, auto-numbered **version**; exactly one version can be flagged **Live** for integrations. Restoring a version copies it back into the draft.
- Models can be exported and imported as **.rbird** files (gzip-compressed JSON containing Studio's structured form of the model, its graph layout and README, but not versions, tests or agents).
- **Co-Author** is Studio's legacy AI assistant, with Plan / Edit / Ask modes; it builds and edits models from prose and documents. In Rae, RAKE does that work. **Consult** runs knowledge-elicitation interviews. This VS Code assistant does the same kind of work inside the editor: it reads the open Raelog file and edits it through tools.
- The **Library** offers templates, patterns and mechanisms; **Automated Tests** replay recorded query sessions with expected results; **Quick Query** and the NL test agent exercise a model interactively.

Consuming decisions:
- **Sessions**: every interaction starts a session for a kmID (draft, a specific version, or the live version). Within a session you can inject facts, run queries, answer questions and run further queries that reuse what is already known. A session expires after 24 hours of inactivity; its evidence remains available.
- **Decisions API** (Community base https://api.rainbird.ai, Enterprise https://enterprise-api.rainbird.ai, header X-API-Key): GET /start/{kmID} (optionally useDraft or a version) → POST /{sessionID}/inject (up to 250 facts per request) → POST /{sessionID}/query with {subject?, relationship, object?} → the engine returns either a **result** (facts with certainty and fact IDs) or a **question**; answer with POST /{sessionID}/response and repeat. Answers can carry a certainty of 1–100; first-form questions take yes/no; a question group (question plus extraQuestions) is answered in one response. A question can be skipped with \`unanswered: true\` and the triple that identifies it (the asked value left out) only when it has \`allowUnknown\` or non-empty \`knownAnswers\`; with known answers the skip means "no more" and the engine keeps them. Inject takes no flags: a plural relationship is asked even when facts for it were injected (so more can be added), and a fact injected below 100% certainty may be asked again for confirmation.
- **Evidence**: every inferred fact has an **evidence tree** (which facts and rules contributed, each with certainty and provenance) reachable by fact ID, optionally protected by an evidence key. The **salience chart** breaks an inferred certainty down per condition.
- Beta natural-language APIs: /interact (ask the model in plain English; the platform extracts facts and drives the query) and /explain (a narrative of an evidence tree).
- Published **Agents** are shareable web Q&A front ends. Every Rae model can be published as an **MCP endpoint** alongside its REST API, so AI agents can call it as a tool; models are also reachable through SDKs and RPA connectors.

Vocabulary: say "model" and "Raelog" yourself. Users may say map, knowledge map, graph or knowledge graph for a model, and RBLang (Raelog's former name) for Raelog; they mean the same things. The Knowledge Map ID (kmID) keeps that name, because it is the label Studio and the API show. Also interchangeable: certainty = certainty factor = cf = confidence; relationship instance = fact (when it has no conditions) or rule (when it has conditions); concept instance = instance = value; Studio = Rainbird Studio, the legacy web app; Co-Author = Studio's legacy assistant.`;
