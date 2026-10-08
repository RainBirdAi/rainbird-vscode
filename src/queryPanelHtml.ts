/**
 * The query panel's webview document, VS Code-free so tests can load it into
 * happy-dom (see src/test/webviewHarness.ts).
 *
 * The page is assembled from regions that each own their CSS and script:
 * base (shared helpers and the message bus), setup (the goal / target / facts
 * card), questions (question cards) and results (result cards, evidence,
 * explanations). The regions are concatenated into ONE <script>, so top-level
 * functions are visible across regions. Messages from the extension are
 * dispatched with emit(type, message); regions subscribe with on(type, fn).
 */
import { BASE_CSS, BASE_SCRIPT, BASE_SCRIPT_END } from "./queryWebview/base";
import { SETUP_CSS, SETUP_SCRIPT } from "./queryWebview/setup";
import { QUESTIONS_CSS, QUESTIONS_SCRIPT } from "./queryWebview/questions";
import { RESULTS_CSS, RESULTS_SCRIPT } from "./queryWebview/results";

export function render(nonce: string = String(Math.random()).slice(2)): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${BASE_CSS}${SETUP_CSS}${QUESTIONS_CSS}${RESULTS_CSS}</style>
</head>
<body>
<div id="head">
  <h2>Rainbird Query</h2>
  <span class="badge" id="km"></span>
  <button id="newQuery">New query</button>
</div>
<div id="flow"></div>
<script nonce="${nonce}">${BASE_SCRIPT}${SETUP_SCRIPT}${QUESTIONS_SCRIPT}${RESULTS_SCRIPT}${BASE_SCRIPT_END}</script>
</body>
</html>`;
}
