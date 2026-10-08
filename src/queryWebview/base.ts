/**
 * Query panel webview, base region: shared helpers (esc, el, busy, addTranscript),
 * the busy spinner, the error card, the notice card and the message bus every
 * region uses. BASE_SCRIPT runs first and BASE_SCRIPT_END last, after all
 * regions have registered their handlers with on(type, fn).
 *
 * BASE_SCRIPT also inlines the shared, VS Code-free helpers every region may
 * call: answers.ts (formatValue, parseHumanDate, describeDate, coerceAnswer…),
 * questionSkip.ts (readKnownAnswers, canSkip, skipLabel…) and goalFilter.ts
 * (rankGoals, canonicalGoal, highlightMatch, groupGoals…). They are inlined once
 * here; regions must not inline them again.
 */
import { ANSWER_WEBVIEW_SOURCE } from "../answers";
import { SKIP_WEBVIEW_SOURCE } from "../questionSkip";
import { GOAL_FILTER_SOURCE } from "../goalFilter";
export const BASE_CSS = /* css */ `
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0;
         padding: 1rem; max-width: 640px; }
  h2 { font-size: 1.05em; font-weight: 600; margin: 0; }
  #head { display: flex; align-items: center; justify-content: space-between; margin-bottom: .9rem; gap: .5rem; }
  .badge { font-size: .75em; opacity: .7; border: 1px solid var(--vscode-panel-border); border-radius: 10px;
           padding: .1rem .5rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
  .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
          border-radius: 8px; padding: .8rem .9rem; margin-bottom: .7rem; }
  .card .prompt { font-weight: 600; margin-bottom: .6rem; line-height: 1.4; }
  label { display: block; font-size: .82em; opacity: .8; margin: .5rem 0 .2rem; }
  select, input[type=text], input[type=number], input[type=date], textarea {
    width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; padding: .35rem .5rem; }
  textarea { font-family: var(--vscode-editor-font-family); font-size: .85em; resize: vertical; margin-top: .3rem; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; border-radius: 5px; padding: .35rem .8rem; cursor: pointer; margin: .15rem .3rem .15rem 0; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .hint { font-size: .78em; opacity: .6; margin-top: .3rem; line-height: 1.4; }
  .transcript { opacity: .75; font-size: .85em; border-left: 2px solid var(--vscode-panel-border);
                padding: .15rem .6rem; margin-bottom: .45rem; }
  .transcript b { opacity: .9; }
  .foot { margin-top: .7rem; display: flex; align-items: center; gap: .3rem; flex-wrap: wrap; }
  .foot .back { margin-left: auto; opacity: .8; }
  .err { color: var(--vscode-errorForeground); }
  .err:empty { display: none; }
  .notice { border-left: 3px solid var(--vscode-editorWarning-foreground, #bf8803); }
  .spin { opacity: .6; font-style: italic; }
`;

export const BASE_SCRIPT = /* js */ `
  // ── Shared helpers inlined from answers.ts, questionSkip.ts and goalFilter.ts ──
${ANSWER_WEBVIEW_SOURCE}
${SKIP_WEBVIEW_SOURCE}
${GOAL_FILTER_SOURCE}
  // ── Base region ──
  const vscode = acquireVsCodeApi();
  const flow = document.getElementById('flow');
  let busyEl = null;

  // Message bus: the extension posts {type, ...}; each region subscribes with on(type, fn).
  // Handlers run in registration order: the regions' (setup, questions, results), then base's
  // busy, error and notice handlers, which BASE_SCRIPT_END registers after them.
  const handlers = {};
  function on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); }
  function emit(type, m) { (handlers[type] || []).forEach(fn => fn(m || {})); }

  function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function el(html) { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function clearBusy() { if (busyEl) { busyEl.remove(); busyEl = null; } }
  function busy() {
    emit('beforeBusy');
    clearBusy(); busyEl = el('<div class="card spin">Rainbird is reasoning…</div>'); flow.appendChild(busyEl); busyEl.scrollIntoView({block:'end'});
  }
  function addTranscript(label, text) {
    flow.appendChild(el('<div class="transcript"><b>' + esc(label) + ':</b> ' + esc(text) + '</div>'));
  }
`;

export const BASE_SCRIPT_END = /* js */ `
  on('busy', () => busy());
  on('error', m => {
    clearBusy();
    flow.appendChild(el('<div class="card err">' + esc(m.message) + '</div>'));
  });
  // A warning that does not stop the query: it goes above the spinner, which keeps running, and no
  // region drops anything for it (the questions region drops pending answer lines on an error).
  on('notice', m => {
    const card = el('<div class="card notice">' + esc(m.message) + '</div>');
    if (busyEl && busyEl.parentNode === flow) flow.insertBefore(card, busyEl);
    else flow.appendChild(card);
  });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m && typeof m.type === 'string') emit(m.type, m);
  });
`;
