/**
 * Query panel webview, results region: result cards with certainty bars and the
 * actions on each result (evidence tree, AI explanation, graph overlay, save as
 * test, compare versions, Back). Messages: result, evidence, evidenceKey,
 * explainDelta, explainDone.
 *
 * The evidence tree is drawn in the extension host by the shared Studio-style
 * renderer (src/evidenceRender.ts) and arrives as HTML in the `evidence`
 * message, so the panel and the standalone evidence view show the same tree.
 * This region puts it in the result's slot and toggles it; EVIDENCE_SCRIPT,
 * inlined here once, runs the tree's toolbar (Expand all, Collapse all, Open in
 * Studio, Copy link, Open in panel). It needs `vscode`, which the base region
 * declares before this region runs.
 */
import { EVIDENCE_CSS, EVIDENCE_SCRIPT } from "../evidenceRender";

export const RESULTS_CSS = /* css */ `
  .result { display: flex; flex-direction: column; gap: .3rem; margin-bottom: .6rem; }
  .fact { font-weight: 600; }
  .bar { height: 6px; border-radius: 3px; background: var(--vscode-panel-border); overflow: hidden; }
  .bar > div { height: 100%; background: var(--vscode-charts-green, #73c991); }
  .pct { font-size: .8em; opacity: .75; }
  .acts { font-size: .8em; margin-top: .15rem; }
  .acts a { color: var(--vscode-textLink-foreground); margin-right: .8em; cursor: pointer; }
  .explain { font-size: .88em; line-height: 1.45; white-space: pre-wrap; border-left: 2px solid var(--vscode-charts-blue, #4d8fd1);
             padding: .3rem .6rem; margin-top: .35rem; }
  .explain:empty { display: none; }
  .ev-locked { font-size: .88em; line-height: 1.45; border-left: 2px solid var(--vscode-editorWarning-foreground, #bf8803);
               padding: .3rem .6rem; margin-top: .35rem; }
  .ev-acts { display: flex; align-items: center; gap: .6rem; margin-top: .4rem; }
  .ev-acts button { margin: 0; }
  .ev-error, .ev-partial { font-size: .88em; margin-top: .35rem; }
  .ev-acts button, .ev-error button, .ev-partial button { font-size: .9em; padding: .2rem .6rem; }
${EVIDENCE_CSS}
  /* The panel stays 640px wide. A tree too wide for its card (deep nesting, a narrow panel) scrolls
     sideways inside the card: each card keeps room for its text next to the impact bar instead of
     squeezing its rows to a word per line. */
  .evtree > .evt { overflow-x: auto; }
  .evtree .evt-card { min-width: 22rem; }
`;

export const RESULTS_SCRIPT = /* js */ `
  // A result's object as the map's data type writes it: a date result arrives as epoch milliseconds.
  // The type is the goal's objectType from the setup region's goal list; a relationship that is not
  // in the list keeps the value as the engine sent it.
  function resultValue(r) {
    const list = typeof goals !== 'undefined' && Array.isArray(goals) ? goals : [];
    const goal = list.find(g => g && g.name === r.relationship);
    return goal && goal.objectType ? formatValue(goal.objectType, r.object) : String(r.object ?? '');
  }

  // A result's evidence slot and its Show / Hide link. Looked up through data-fact rather than a CSS
  // selector built from the factID; the newest card wins should a factID ever appear twice.
  function evidenceParts(factId) {
    const slots = [...flow.querySelectorAll('.evtree')].filter(s => s.dataset.fact === factId);
    const slot = slots.length ? slots[slots.length - 1] : null;
    const row = slot ? slot.closest('.result') : null;
    return { slot, link: row ? row.querySelector('[data-ev]') : null };
  }

  // The link reads Show evidence, Loading evidence… or Hide evidence; aria-expanded follows the slot.
  function setEvidenceLink(slot, link, state) {
    if (!link) return;
    link.dataset.state = state;
    link.textContent = state === 'loading' ? 'Loading evidence…' : state === 'shown' ? 'Hide evidence' : 'Show evidence';
    link.setAttribute('aria-expanded', String(!slot.hidden));
  }

  // While a tree loads, its slot holds a placeholder: a locked or error card, and its Retry, are gone.
  function evidenceLoading(slot, link) {
    slot.dataset.state = 'loading';
    slot.innerHTML = '<div class="hint ev-loading">Loading evidence…</div>';
    setEvidenceLink(slot, link, 'loading');
  }

  // One request at a time per result: Show evidence and Retry do nothing while the tree loads.
  function requestEvidence(factId) {
    const { slot, link } = evidenceParts(factId);
    if (!slot || slot.dataset.state === 'loading') return;
    evidenceLoading(slot, link);
    vscode.postMessage({ type: 'evidence', factId });
  }

  // Show evidence → Loading evidence… → Hide evidence. A complete tree, and an expired session's card
  // (nothing can load it any more), stay in the page, so hiding and showing them again are instant. A
  // locked or error card, or a tree with facts that could not be loaded, is fetched again instead.
  function toggleEvidence(factId) {
    const { slot, link } = evidenceParts(factId);
    if (!slot || slot.dataset.state === 'loading') return;
    if (!slot.hidden) {
      slot.hidden = true;
      setEvidenceLink(slot, link, 'hidden');
    } else if (slot.dataset.state === 'tree' || slot.dataset.state === 'expired') {
      slot.hidden = false;
      setEvidenceLink(slot, link, 'shown');
    } else requestEvidence(factId);
  }

  // 401 / 403 from the evidence API. Set evidence key… asks the extension for the key, which loads the tree
  // again only when the key changed; Retry is for the other remedy, enabling Evidence Tree Link in Studio.
  function lockedEvidenceHtml(factId) {
    return '<div class="ev-locked">Evidence is locked for this map. Enable Evidence Tree Link in Studio (Publish → API Management → Access Control), or enter the map\\'s evidence key.'
      + '<div class="ev-acts"><button type="button" data-ev-setkey="' + esc(factId) + '">Set evidence key…</button>'
      + '<button type="button" data-ev-retry="' + esc(factId) + '" title="Load the evidence again, for example after enabling Evidence Tree Link in Studio">Retry</button></div></div>';
  }

  // Any other failure. An expired session gets no Retry: only a new query can help.
  function evidenceErrorHtml(factId, message, retry) {
    return '<div class="err ev-error">' + esc(message || 'Could not load the evidence.')
      + (retry ? ' <button type="button" data-ev-retry="' + esc(factId) + '">Retry</button>' : '') + '</div>';
  }

  // Under a tree with facts that could not be loaded (the tree's own note says which rows).
  function partialEvidenceHtml(factId) {
    return '<div class="ev-partial"><button type="button" data-ev-retry="' + esc(factId) + '" title="Load the evidence again, including the facts that could not be loaded">Retry</button></div>';
  }

  function explainLinkHtml(factId) {
    return '<a data-explain="' + esc(factId) + '" role="button" tabindex="0">Explain (AI)</a>';
  }

  function resultCards(results, sessionId) {
    clearBusy();
    const card = el('<div class="card"></div>');
    if (!results.length) {
      card.innerHTML = '<div class="prompt">No results</div><div>The engine could not derive an answer from what it was told.</div>';
    } else {
      card.innerHTML = '<div class="prompt">Result' + (results.length > 1 ? 's' : '') + '</div>'
        + results.map(r =>
          '<div class="result"><span class="fact">' + esc(r.subject) + ' ' + esc(r.relationship) + ' ' + esc(resultValue(r)) + '</span>'
          + '<div class="bar"><div style="width:' + Math.max(0, Math.min(100, r.certainty)) + '%"></div></div>'
          + '<span class="pct">' + esc(r.certainty) + '% certain</span>'
          + '<div class="acts">'
          + '<a data-ev="' + esc(r.factID) + '" role="button" tabindex="0" aria-expanded="false" aria-controls="ev-' + esc(r.factID) + '">Show evidence</a>'
          + explainLinkHtml(r.factID)
          + '<a data-overlay="' + esc(r.factID) + '" role="button" tabindex="0">Show on graph</a>'
          + '</div>'
          + '<div class="explain" id="ex-' + esc(r.factID) + '"></div>'
          + '<div class="evtree" id="ev-' + esc(r.factID) + '" data-fact="' + esc(r.factID) + '" hidden></div></div>').join('');
    }
    card.innerHTML += '<div class="foot"><button class="primary" id="again">Run another query</button>'
      + (results.length ? '<button id="saveTest">Save as test</button><button id="compare" title="Replay this session against another version and diff the outcome">Compare with another version…</button>' : '')
      + '<button class="back" title="Undo the last answer and continue">↶ Back</button></div>';
    flow.appendChild(card);
    card.scrollIntoView({ block: 'end' });
    // The card that had the focus is gone (answered, or replaced by the spinner): Show evidence takes the focus, or
    // Run another query when there is no result.
    const first = card.querySelector('.acts a, #again');
    if (first) first.focus({ preventScroll: true });
    // Clicks on the tree's own toolbar (data-evt-act) and its "Go to it" links belong to EVIDENCE_SCRIPT;
    // none of the branches below matches them.
    card.addEventListener('click', e => {
      const t = e.target;
      if (!t) return;
      const d = t.dataset || {};
      if (d.ev) {
        toggleEvidence(d.ev);
      } else if (d.evSetkey) {
        // One key prompt at a time: the locked card's buttons wait for the extension's evidenceKey answer.
        const locked = t.closest('.ev-locked');
        (locked ? [...locked.querySelectorAll('button')] : [t]).forEach(b => { b.disabled = true; });
        vscode.postMessage({ type: 'evidenceAction', action: 'setKey', factId: d.evSetkey });
      } else if (d.evRetry) {
        requestEvidence(d.evRetry);
      } else if (d.explain) {
        const slot = document.getElementById('ex-' + d.explain);
        if (slot) slot.textContent = '…';
        // The link goes once used. When it had the focus, the next action (Show on graph) takes it rather than the page.
        const next = document.activeElement === t ? t.nextElementSibling : null;
        t.remove();
        if (next) next.focus();
        vscode.postMessage({ type: 'explain', factId: d.explain });
      } else if (d.overlay) {
        vscode.postMessage({ type: 'overlay', factId: d.overlay });
      } else if (t.id === 'saveTest') {
        vscode.postMessage({ type: 'saveTest' });
      } else if (t.id === 'compare') {
        vscode.postMessage({ type: 'compare' });
      } else if (t.classList && t.classList.contains('back')) {
        card.remove(); addTranscript('↶', 'back one step'); vscode.postMessage({ type: 'undo' });
      } else if (t.id === 'again') setup();
    });
    // The row's actions are links without an href: Enter and Space work them like the buttons they are.
    card.addEventListener('keydown', e => {
      const t = e.target;
      if ((e.key === 'Enter' || e.key === ' ') && t && t.tagName === 'A' && t.getAttribute('role') === 'button') {
        e.preventDefault();
        t.click();
      }
    });
  }

  on('result', m => resultCards(m.results || [], m.sessionId));
  // { factId, html, partial? } for a tree (renderEvidenceHtml's output, every value already escaped in the
  // extension; partial when some of its facts could not be loaded), { factId, locked: true } for 401 / 403,
  // { factId, error, expired? } otherwise (expired: the session is gone).
  on('evidence', m => {
    const { slot, link } = evidenceParts(m.factId);
    if (!slot) return;
    if (typeof m.html === 'string' && m.html) {
      slot.innerHTML = m.html + (m.partial ? partialEvidenceHtml(m.factId) : '');
      slot.dataset.state = m.partial ? 'partial' : 'tree';
    } else if (m.locked) {
      slot.innerHTML = lockedEvidenceHtml(m.factId);
      slot.dataset.state = 'locked';
    } else {
      slot.innerHTML = evidenceErrorHtml(m.factId, m.error, !m.expired);
      slot.dataset.state = m.expired ? 'expired' : 'error';
    }
    slot.hidden = false;
    setEvidenceLink(slot, link, 'shown');
    slot.scrollIntoView({ block: 'nearest' });
  });
  // { factId, changed }: the answer to Set evidence key…. Changed: the extension is loading the tree with the
  // new key and its evidence message follows. Cancelled or the same key: the slot stays as it is (a tree
  // loaded meanwhile is kept) and the locked card's buttons work again.
  on('evidenceKey', m => {
    const { slot, link } = evidenceParts(m.factId);
    if (!slot) return;
    if (m.changed) evidenceLoading(slot, link);
    else slot.querySelectorAll('.ev-locked button').forEach(b => { b.disabled = false; });
  });
  on('explainDelta', m => {
    const slot = document.getElementById('ex-' + m.factId);
    if (slot) {
      if (slot.textContent === '…') slot.textContent = '';
      slot.textContent += m.text;
      slot.scrollIntoView({ block: 'nearest' });
    }
  });
  // { factId, failed? }. A failed explanation (no Anthropic key, locked or expired evidence, a network error)
  // gives the Explain (AI) link back, so it can be tried again once the cause is fixed.
  on('explainDone', m => {
    if (!m.failed) return;
    const slot = document.getElementById('ex-' + m.factId);
    const row = slot ? slot.closest('.result') : null;
    const acts = row ? row.querySelector('.acts') : null;
    if (!acts || acts.querySelector('[data-explain]')) return;
    acts.insertBefore(el(explainLinkHtml(m.factId)), acts.querySelector('[data-overlay]'));
  });

  // ── Evidence tree toolbar (shared with the standalone evidence view; installs itself once) ──
${EVIDENCE_SCRIPT}
`;
