/**
 * Knowledge reference, part 1: what Rainbird is. Written for the assistant's
 * system prompt so it can answer product questions and reason about where a
 * knowledge map sits in the platform (draft, versions, sessions, evidence).
 * Clean-room prose derived from Rainbird's public documentation.
 */

export const PLATFORM_SECTION = `## 1. What Rainbird is

Rainbird is a decision-intelligence platform: domain expertise is encoded as a **knowledge map** (increasingly called a knowledge graph) and a symbolic **Reasoning Engine** answers queries against it deterministically, with a certainty score and a full evidence trail. There is no LLM inside the decision loop; language models are used only around the edges (authoring, natural-language front ends, explanations).

Building blocks of a knowledge map:
- **Concepts** — typed containers of things (Person, Country, Age). Types: string, number, date, truth.
- **Relationships** — directional links from a subject concept to an object concept ("Person speaks Language"). They can be singular or plural, and can be *askable*, meaning the engine may ask a user for the missing value.
- **Facts** — subject → relationship → object triples with a certainty from 0 to 100 ("Julio lives in France, cf 100"). Facts come from the map itself, from injection via API, from a user's answer, from a datasource, or from a rule.
- **Rules** — conditions over relationships and expressions that let the engine infer new facts. A rule's header names the relationship it infers and caps the certainty of anything it produces.
- **Datasources** — REST calls the engine makes mid-inference to fetch facts from external APIs.

Tooling and lifecycle:
- **Rainbird Studio** is the web authoring environment (Community at app.rainbird.ai, Enterprise at enterprise.rainbird.ai). The visual graph and the RBLang code panel are two views of the same model. Studio auto-saves to the map's single editable **draft**.
- Every map has a **kmID** (knowledge map ID), shown on its Publish page. **Publishing** creates an immutable, auto-numbered **version**; exactly one version can be flagged **Live** for integrations. Restoring a version copies it back into the draft.
- Maps can be exported and imported as **.rbird** files (gzip-compressed JSON containing the model, graph layout and README, but not versions, tests or agents).
- **Co-author** (beta) is Studio's AI assistant with Plan / Edit / Ask modes; it builds and edits maps from prose and documents. **Consult** runs knowledge-elicitation interviews. This VS Code assistant plays the same role inside the editor: it reads the open RBLang file and edits it through tools.
- The **Library** offers templates, patterns and mechanisms; **Automated Tests** replay recorded query sessions with expected results; **Quick Query** and the NL test agent exercise a map interactively.

Consuming decisions:
- **Sessions**: every interaction starts a session for a kmID (draft, a specific version, or the live version). Within a session you can inject facts, run queries, answer questions and run further queries that reuse what is already known. A session expires after 24 hours of inactivity; its evidence remains available.
- **Decisions API** (Community base https://api.rainbird.ai, Enterprise https://enterprise-api.rainbird.ai, header X-API-Key): GET /start/{kmID} (optionally useDraft or a version) → POST /{sessionID}/inject (up to 250 facts per request) → POST /{sessionID}/query with {subject?, relationship, object?} → the engine returns either a **result** (facts with certainty and fact IDs) or a **question**; answer with POST /{sessionID}/response and repeat. Answers can carry a certainty of 1–100; first-form questions take yes/no.
- **Evidence**: every inferred fact has an **evidence tree** (which facts and rules contributed, each with certainty and provenance) reachable by fact ID, optionally protected by an evidence key. The **salience chart** breaks an inferred certainty down per condition.
- Beta natural-language APIs: /interact (ask the map in plain English; the platform extracts facts and drives the query) and /explain (a narrative of an evidence tree).
- Published **Agents** are shareable web Q&A front ends; maps can also be exposed as **MCP** tools for AI agents, and through SDKs and RPA connectors.

Vocabulary the user may use interchangeably: knowledge map = knowledge graph = graph = map; certainty = certainty factor = cf = confidence; relationship instance = fact (when it has no conditions) or rule (when it has conditions); concept instance = instance = value; Studio = the Rainbird web app; Co-author = Studio's assistant.`;
