/**
 * Query panel webview, setup region: the "What should Rainbird work out?" card
 * (goal relationship, subject / object, target version, facts to inject) and the
 * header badge naming the map, with its "Change…" link.
 * Messages in: init, session, mapInfo, startError, factsText, and question, result and autoSkipped,
 * which end a start. Out: start, pickFacts, changeKm, newQuery.
 *
 * The goal relationship field is a searchable combobox over the map's
 * relationships, built on rankGoals, groupGoals, highlightMatch and
 * canonicalGoal from goalFilter.ts (inlined once by the base region). An empty
 * query lists every goal, grouped; typing filters by name, subject or object.
 * With no goal list the field stays a plain text input.
 *
 * Shared with the other regions (one script scope): `goals` holds the goals of
 * the last init message, each with objectType (the object concept's data type,
 * which the results region formats values with), and setup() shows a fresh
 * setup card ("Run another query" calls it).
 *
 * The VS Code-free functions after the script are the extension's side of the
 * same contract: the goal list the init message carries, the goal to prefill,
 * the per-map memory of the last goal, and the copy of the panel's map errors
 * (the note on a 400 for an unknown goal, and the card after a cancelled map prompt).
 */
import type { StartTarget } from "../api";
import { canonicalGoal } from "../goalFilter";
import { Goal, goalsFromIndex } from "../goals";
import { normaliseKmId } from "../kmId";
import { buildIndex } from "../mapIndex";

export const SETUP_CSS = /* css */ `
  .row2 { display: flex; gap: .6rem; }
  .row2 > div { flex: 1; min-width: 0; }
  details.facts { margin-top: .6rem; font-size: .9em; }
  details.facts summary { cursor: pointer; opacity: .85; }
  .factsNote { font-size: .8em; opacity: .7; margin-left: .4rem; }
  .startErr { font-size: .85em; margin-top: .5rem; white-space: pre-wrap; }
  .mapNote { font-size: .85em; margin-bottom: .6rem; line-height: 1.4; }
  #head .badge { margin-left: auto; }
  .changeKm { background: none; padding: 0 .15rem; margin: 0; font-size: .8em; white-space: nowrap;
              color: var(--vscode-textLink-foreground); }
  .changeKm:hover { background: none; text-decoration: underline;
                    color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
  .combo { position: relative; }
  .combo-list { position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 10; max-height: 18rem; overflow-y: auto;
                padding: .2rem 0; border-radius: 5px; box-shadow: 0 2px 8px rgba(0, 0, 0, .3);
                background: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background));
                border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border)); }
  .combo-list:focus { outline: none; }
  .combo-head { font-size: .72em; text-transform: uppercase; letter-spacing: .04em; opacity: .65; padding: .45rem .6rem .15rem; }
  .combo-row { padding: .3rem .6rem; cursor: pointer; line-height: 1.35; }
  .combo-row:hover { background: var(--vscode-list-hoverBackground); }
  .combo-row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .combo-top, .combo-sub { display: flex; justify-content: space-between; align-items: baseline; gap: .2rem .6rem; flex-wrap: wrap; }
  .combo-name b { color: var(--vscode-list-highlightForeground, var(--vscode-textLink-foreground)); }
  .combo-row.active .combo-name b { color: inherit; text-decoration: underline; }
  .combo-sub { font-size: .8em; opacity: .75; }
  .combo-sub b { font-weight: 600; }
  .combo-count { white-space: nowrap; }
  .combo-tags { margin-left: auto; }
  .combo-tag { display: inline-block; font-size: .72em; border: 1px solid var(--vscode-panel-border); border-radius: 8px;
               padding: 0 .45em; margin-left: .3rem; white-space: nowrap; }
  .combo-tag.warn { color: var(--vscode-editorWarning-foreground); border-color: currentColor; }
  .combo-free { font-style: italic; }
  .combo-empty { padding: .35rem .6rem; font-size: .85em; opacity: .75; }
  .goalMeta:empty { display: none; }
  .goalMeta.warn { opacity: .9; color: var(--vscode-editorWarning-foreground); }
`;

export const SETUP_SCRIPT = /* js */ `
  let goals = [], goalsFrom = 'none', goalsAskableMixed = false, preselect = null, preselectWhy = '', defaultTarget = 'draft', pendingSetup = null;
  // init.mapNote: the platform has no map with this Knowledge Map ID. Every setup card shows it until the next init.
  let setupMapNote = '';
  // The "Goal: …" transcript line that stands in for the hidden setup card while the query starts.
  let setupLine = null;

  // Once the engine starts reasoning, the setup card gives way to a "Goal: …" transcript line. The card
  // is only hidden until the engine replies: a start that fails (startError) puts it back as it was, every
  // field still filled in, and the first question, result or automatic answer removes it for good.
  on('beforeBusy', () => {
    if (!pendingSetup || pendingSetup.hidden) return;
    addTranscript('Goal', pendingSetup.dataset.summary || '');
    setupLine = flow.lastElementChild;
    pendingSetup.hidden = true;
  });
  // These run before the questions and results regions' handlers (regions register in order).
  function setupStarted() {
    if (!pendingSetup || !pendingSetup.hidden) return;
    pendingSetup.remove();
    pendingSetup = null;
    setupLine = null;
  }
  on('question', setupStarted);
  on('result', setupStarted);
  on('autoSkipped', setupStarted);

  // "Change…" beside the map badge: the extension binds the open file to another
  // map, or, with no file, asks for a Knowledge Map ID; then it sends a new init.
  (function () {
    const km = document.getElementById('km');
    if (!km || !km.parentNode) return;
    const change = el('<button type="button" class="changeKm" id="changeKm" title="Choose the map to query">Choose map…</button>');
    km.parentNode.insertBefore(change, km.nextSibling);
    change.addEventListener('click', () => vscode.postMessage({ type: 'changeKm' }));
  })();

  function setupCount(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function setupGoalSource() { return goalsFrom === 'platform' ? 'the platform draft' : 'the open map'; }
  function setupMarked(segments) { return segments.map(s => s.match ? '<b>' + esc(s.text) + '</b>' : esc(s.text)).join(''); }
  // How many goals a name the map does not declare matches by name, subject or
  // object (acronym matches do not count): a name with matches is most likely
  // half-typed, one with none is meant as typed.
  function setupNearMatches(text) { return rankGoals(goals, text).filter(m => m.matched !== 'subsequence').length; }

  // What a picker row, and the line under the field, say about a goal. Counts
  // cover the map text only, so "no rules or facts" is a neutral note; only an
  // askable="none" relationship with neither is one the engine cannot answer.
  function setupGoalFacts(g) {
    const counted = typeof g.rules === 'number' || typeof g.facts === 'number';
    const rules = g.rules || 0, facts = g.facts || 0;
    const counts = !counted ? '' : rules || facts ? setupCount(rules, 'rule') + ' · ' + setupCount(facts, 'fact') : 'no rules or facts in ' + setupGoalSource();
    const tags = [];
    if (g.askable === 'none' && counted && !rules && !facts) tags.push({ text: 'the engine cannot answer it without injected facts', warn: true });
    else if (g.askable === 'none' && goalsAskableMixed) tags.push({ text: 'not askable', warn: false });
    return { link: g.subject + ' → ' + g.object + (g.plural ? ' · plural' : ''), counts, tags };
  }

  // One option, two lines: the name and its tags, then subject → object and
  // the counts. The spaces between parts render as nothing but keep the text
  // (and so the accessible name) readable: "speaks Person → Language · plural 1 rule · 0 facts".
  function setupGoalRow(g, q, matched, id) {
    const f = setupGoalFacts(g);
    return '<div class="combo-row" role="option" aria-selected="false" id="' + id + '" data-name="' + esc(g.name) + '">'
      + '<div class="combo-top"><span class="combo-name">' + setupMarked(highlightMatch(g.name, q, matched)) + '</span>'
      + (f.tags.length ? ' <span class="combo-tags">' + f.tags.map(t => '<span class="combo-tag' + (t.warn ? ' warn' : '') + '">' + esc(t.text) + '</span>').join(' ') + '</span>' : '')
      + '</div> '
      + '<div class="combo-sub"><span class="combo-link">' + setupMarked(highlightMatch(g.subject, q)) + ' → ' + setupMarked(highlightMatch(g.object, q))
      + (g.plural ? ' · plural' : '') + '</span>' + (f.counts ? ' <span class="combo-count">' + esc(f.counts) + '</span>' : '') + '</div>'
      + '</div>';
  }

  // The searchable goal field. The listbox exists only while it is open, and so
  // do aria-controls and aria-activedescendant. Rows are picked on mousedown, with
  // the default prevented, so the field keeps its focus. changed() runs whenever
  // the user changes the goal, by typing or by picking a row.
  function setupGoalPicker(card, startable, startQuery, changed) {
    const input = card.querySelector('.goal');
    const wrap = card.querySelector('.combo');
    const meta = card.querySelector('.goalMeta');
    let list = null, active = -1, why = '', holding = false;
    const rows = () => list ? [...list.querySelectorAll('.combo-row')] : [];

    // The list for what is typed, and the row Enter picks by default (-1: none).
    function listMarkup() {
      const q = input.value.trim();
      let html = '', next = 0;
      const row = (g, matched) => setupGoalRow(g, q, matched, 'goalOpt-' + (next++));
      if (!q) {
        // Every goal, grouped over the whole list: nothing is cut off, the box scrolls.
        const grouped = groupGoals(goals);
        const group = (title, members) => {
          if (!members.length) return '';
          const head = title + ' (' + members.length + ')';
          return '<div role="group" aria-label="' + esc(head) + '"><div class="combo-head" aria-hidden="true">' + esc(head) + '</div>'
            + members.map(g => row(g, 'name')).join('') + '</div>';
        };
        return { html: group('Inferred by rules', grouped.inferred) + group('Other relationships', grouped.other), first: -1 };
      }
      const matches = rankGoals(goals, q);
      // Nothing matched, or only acronyms ("hti" → has total income): offer the
      // text as typed, first, so Enter never silently swaps in an acronym match.
      if (matches.every(m => m.matched === 'subsequence')) {
        if (!matches.length) html += '<div class="combo-empty" aria-hidden="true">No relationship in ' + esc(setupGoalSource()) + ' matches “' + esc(q) + '”.</div>';
        html += '<div class="combo-row combo-free" role="option" aria-selected="false" id="goalOpt-' + (next++) + '" data-free="1">Use “' + esc(q) + '” as typed</div>';
      }
      html += matches.map(m => row(m.goal, m.matched)).join('');
      return { html, first: 0 };
    }

    function setActive(i, scroll) {
      const rs = rows();
      active = i >= 0 && i < rs.length ? i : -1;
      rs.forEach((r, k) => { r.classList.toggle('active', k === active); r.setAttribute('aria-selected', k === active ? 'true' : 'false'); });
      if (active < 0) { input.removeAttribute('aria-activedescendant'); return; }
      input.setAttribute('aria-activedescendant', rs[active].id);
      if (scroll) rs[active].scrollIntoView({ block: 'nearest' });
    }

    function openList() {
      if (!list) {
        list = el('<div class="combo-list" id="goalList" role="listbox" tabindex="-1" aria-label="Relationships"></div>');
        list.addEventListener('mousedown', e => {
          const row = e.target && e.target.closest ? e.target.closest('.combo-row') : null;
          if (row) { e.preventDefault(); pick(row); return; }
          // A heading or the scrollbar (dragging it must work): keep the list open
          // while the field loses focus, until the press ends (release below).
          holding = true;
          document.addEventListener('mouseup', release);
          window.addEventListener('blur', release);
        });
        wrap.appendChild(list);
        input.setAttribute('aria-controls', 'goalList');
        input.setAttribute('aria-expanded', 'true');
      }
      const m = listMarkup();
      list.innerHTML = m.html;
      list.scrollTop = 0; // new rows for a new query: its best match is at the top
      setActive(m.first, false);
    }

    // The end of a press in the list. On release the field gets its focus back,
    // unless focus has moved on to another control meanwhile. A button released
    // outside the panel never reaches it, so the panel losing focus ends the
    // press too, and closes the list.
    function release(e) {
      document.removeEventListener('mouseup', release);
      window.removeEventListener('blur', release);
      if (!holding) return;
      holding = false;
      if (!list) return;
      const at = document.activeElement;
      if (e.type === 'mouseup' && (!at || at === document.body || wrap.contains(at))) input.focus();
      else { closeList(); describe(); }
    }

    function closeList() {
      if (!list) return;
      list.remove();
      list = null;
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-controls');
      input.removeAttribute('aria-activedescendant');
    }

    // The line under the field: what the chosen goal is, the declared spelling
    // Start query will use, or a warning that the name is not in the map.
    function describe(origin) {
      if (origin !== undefined) why = origin;
      const v = input.value.trim();
      const exact = v ? goals.find(g => g.name === v) : null;
      const canon = v && !exact ? canonicalGoal(goals, v) : undefined;
      let text = '', warn = false;
      if (exact) {
        const f = setupGoalFacts(exact);
        text = f.link + (f.counts ? ' · ' + f.counts : '') + f.tags.map(t => ' · ' + t.text).join('') + (why ? ' — ' + why : '');
      } else if (canon) {
        warn = true;
        text = goalCollapse(v) === goalCollapse(canon)
          ? 'Start query will use the declared spelling “' + canon + '”.'
          : 'Did you mean “' + canon + '”? Names are case-sensitive — Start query will use that spelling.';
      } else if (v && !list) {
        warn = true;
        const near = setupNearMatches(v);
        text = '“' + v + '” is not a relationship in ' + setupGoalSource() + ' — ' + (!near
          ? 'Start query will send it exactly as typed.'
          : near === 1 ? 'choose the one that matches from the list.' : 'choose one of the ' + near + ' that match from the list.');
      }
      meta.textContent = text;
      meta.classList.toggle('warn', warn);
    }

    function pick(row) {
      if (!row.dataset.free) input.value = row.dataset.name;
      closeList();
      describe('');
      changed();
      card.querySelector('.subject').focus();
    }

    input.addEventListener('input', () => { openList(); describe(''); changed(); });
    input.addEventListener('click', () => { if (!list) { openList(); describe(); } });
    wrap.addEventListener('focusout', e => {
      if (holding || (e.relatedTarget && wrap.contains(e.relatedTarget))) return;
      closeList();
      describe();
    });
    input.addEventListener('keydown', e => {
      if (e.isComposing) return; // Enter or an arrow while an input method composes belongs to it
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const down = e.key === 'ArrowDown';
        const wasOpen = !!list;
        if (!wasOpen) { openList(); describe(); }
        const count = rows().length;
        if (!count) return;
        let next = active;
        if (active < 0) next = down ? 0 : count - 1;
        else if (wasOpen) next = Math.max(0, Math.min(count - 1, active + (down ? 1 : -1)));
        setActive(next, true);
      } else if (e.key === 'Enter') {
        if (list && active >= 0) { e.preventDefault(); pick(rows()[active]); return; }
        if (list) { closeList(); describe(); }
        if (startable()) { e.preventDefault(); startQuery(); }
      } else if (e.key === 'Escape') {
        if (list) { e.preventDefault(); closeList(); describe(); }
      } else if (e.key === 'Tab') {
        closeList();
        describe();
      }
    });
    return { describe };
  }

  function setup() {
    flow.innerHTML = '';
    pendingSetup = null;
    setupLine = null;
    const n = goals.length;
    const goalField = n
      ? '<label for="goalInput">Goal relationship (from ' + setupGoalSource() + ')</label>'
        + '<div class="combo"><input type="text" class="goal" id="goalInput" role="combobox" aria-autocomplete="list" aria-expanded="false"'
        + ' aria-describedby="goalMeta" autocomplete="off" spellcheck="false" placeholder="Type to search ' + setupCount(n, 'relationship') + '…">'
        // Inside the combo, so the list opens below it and never hides the case hint.
        + '<div class="hint goalMeta" id="goalMeta" aria-live="polite"></div></div>'
      : '<label for="goalInput">Goal relationship</label><input type="text" class="goal" id="goalInput" placeholder="e.g. speaks">'
        + '<div class="hint">Type the relationship name exactly as the map declares it — names are case-sensitive.</div>';
    const card = el('<div class="card">'
      + '<div class="prompt">What should Rainbird work out?</div>'
      + (setupMapNote ? '<div class="err mapNote">' + esc(setupMapNote) + '</div>' : '')
      + goalField
      + '<div class="row2">'
      // Either may be empty, but not both: the engine rejects a query with neither.
      + '<div><label>Subject</label><input type="text" class="subject" placeholder="e.g. Fred"></div>'
      + '<div><label>Object</label><input type="text" class="object" placeholder="e.g. French"></div>'
      + '</div>'
      + '<div class="hint">Fill the subject to ask “what does Fred …”, the object to ask “who …”, or both to ask how certain one fact is.</div>'
      + '<div class="row2">'
      + '<div><label>Run against</label><select class="target">'
      + '<option value="draft">Draft (working copy)</option><option value="live">Live version</option><option value="version">A specific version…</option></select></div>'
      + '<div class="verwrap" style="display:none"><label>Version number</label><input type="number" class="version" min="1" placeholder="e.g. 3"></div>'
      + '</div>'
      + '<details class="facts"><summary>Facts to inject before the query (optional)</summary>'
      + '<textarea class="factsText" rows="4" placeholder="JSON: [{&quot;subject&quot;:&quot;Fred&quot;,&quot;relationship&quot;:&quot;lives in&quot;,&quot;object&quot;:&quot;France&quot;,&quot;certainty&quot;:100}]&#10;or CSV, one per line: Fred,lives in,France,100"></textarea>'
      + '<div><button class="loadFacts">Load from file…</button><span class="factsNote"></span></div></details>'
      + '<div class="err startErr"></div>'
      + '<div style="margin-top:.7rem"><button class="primary go">Start query</button></div>'
      + '</div>');
    flow.appendChild(card);
    const goalEl = card.querySelector('.goal');
    const targetEl = card.querySelector('.target');
    targetEl.value = defaultTarget;
    targetEl.addEventListener('change', () => { card.querySelector('.verwrap').style.display = targetEl.value === 'version' ? '' : 'none'; });
    card.querySelector('.loadFacts').addEventListener('click', () => vscode.postMessage({ type: 'pickFacts' }));

    // The goal Start query sends: the declared spelling of what was typed (the engine is case-sensitive).
    const goalValue = () => canonicalGoal(goals, goalEl.value) ?? goalEl.value.trim();
    // Enter starts the query once the field names one of the map's goals (any name when there is no list).
    const startable = () => { const v = goalValue(); return !!v && (!n || goals.some(g => g.name === v)); };
    const errSlot = card.querySelector('.startErr');
    let picker = null;
    // A name the map does not declare, Start query was clicked for once and told
    // about; a second click sends it as typed. Any change to the goal forgets it.
    let confirmed = null, confirmShown = false;
    function goalChanged() {
      confirmed = null;
      if (confirmShown) { confirmShown = false; errSlot.textContent = ''; }
    }

    function startQuery() {
      if (pendingSetup === card) return;
      errSlot.textContent = '';
      confirmShown = false;
      const goal = goalValue();
      if (!goal) { errSlot.textContent = 'Pick a goal relationship.'; goalEl.focus(); return; }
      // Relationships match what was typed, but none is named exactly that: it is
      // most likely half-typed, and the engine would reject it. Ask once.
      if (n && goal !== confirmed && !goals.some(g => g.name === goal) && setupNearMatches(goal)) {
        confirmed = goal;
        confirmShown = true;
        errSlot.textContent = '“' + goal + '” is not one of the map’s relationships — pick one from the list, or click Start query again to send it as typed.';
        goalEl.focus();
        return;
      }
      goalEl.value = goal;
      if (picker) picker.describe('');
      const subject = card.querySelector('.subject').value.trim();
      const object = card.querySelector('.object').value.trim();
      const kind = targetEl.value;
      const version = Number(card.querySelector('.version').value);
      if (kind === 'version' && !(Number.isInteger(version) && version > 0)) { errSlot.textContent = 'Enter a version number.'; return; }
      const facts = card.querySelector('.factsText').value;
      const target = kind === 'version' ? { kind, version } : { kind };
      card.dataset.summary = goal + (subject ? ' — subject: ' + subject : '') + (object ? ' — object: ' + object : '')
        + ' · ' + (kind === 'version' ? 'version ' + version : kind) + (facts.trim() ? ' · with injected facts' : '');
      // "New query" and "Run another query" start from the goal just run.
      preselect = goal;
      preselectWhy = 'last goal for this map';
      pendingSetup = card;
      const go = card.querySelector('.go'); go.disabled = true; go.textContent = 'Starting…';
      vscode.postMessage({ type: 'start', relationship: goal, subject: subject || undefined, object: object || undefined, target, facts });
    }

    card.querySelector('.go').addEventListener('click', startQuery);
    const enterStarts = e => { if (e.key === 'Enter' && !e.isComposing && startable()) { e.preventDefault(); startQuery(); } };
    card.querySelectorAll('.subject, .object').forEach(f => f.addEventListener('keydown', enterStarts));
    if (preselect) goalEl.value = preselect;
    if (n) {
      picker = setupGoalPicker(card, startable, startQuery, goalChanged);
      picker.describe(preselect ? preselectWhy : '');
    } else goalEl.addEventListener('keydown', enterStarts);
    // With a goal prefilled the subject is the next thing to type.
    (preselect ? card.querySelector('.subject') : goalEl).focus();
  }

  // The extension forgets the session on screen too, so ▶ does not ask about a query nobody sees.
  document.getElementById('newQuery').addEventListener('click', () => { vscode.postMessage({ type: 'newQuery' }); setup(); });

  on('init', m => {
    goals = m.goals || [];
    setupMapNote = m.mapNote || '';
    goalsFrom = m.goalsFrom || 'none';
    goalsAskableMixed = !!m.askableMixed;
    preselect = m.preselect || null;
    preselectWhy = m.preselectFrom === 'editor' ? 'from the editor' : m.preselectFrom === 'last' ? 'last goal for this map' : '';
    defaultTarget = m.useDraft ? 'draft' : 'live';
    const km = document.getElementById('km');
    km.dataset.km = m.kmId;
    km.dataset.base = defaultTarget + ' · ' + m.kmId;
    km.textContent = km.dataset.base;
    km.title = m.apiUrl + ' — ' + m.kmId;
    const change = document.getElementById('changeKm');
    if (change) {
      change.textContent = 'Change…';
      change.title = m.fileName ? 'Bind ' + m.fileName + ' to a different Knowledge Map ID' : 'Query a different map by its Knowledge Map ID';
    }
    setup();
  });
  on('session', m => {
    const km = document.getElementById('km');
    km.dataset.base = m.target + ' · ' + (km.dataset.km || '');
    km.textContent = km.dataset.base;
  });
  on('mapInfo', m => {
    const km = document.getElementById('km');
    km.textContent = m.name + (m.status ? ' (' + m.status + ')' : '') + ' — ' + (km.dataset.base || km.textContent);
  });
  on('startError', m => {
    if (pendingSetup) {
      // The start failed after busy: the card comes back in place of its "Goal: …" line, and the spinner goes.
      if (pendingSetup.hidden) {
        clearBusy();
        if (setupLine) setupLine.remove();
        pendingSetup.hidden = false;
      }
      pendingSetup.querySelector('.startErr').textContent = m.message;
      const go = pendingSetup.querySelector('.go'); go.disabled = false; go.textContent = 'Start query';
      pendingSetup = null;
    } else {
      flow.appendChild(el('<div class="card err">' + esc(m.message) + '</div>'));
    }
    setupLine = null;
  });
  on('factsText', m => {
    const area = flow.querySelector('.factsText');
    if (area) {
      area.value = m.text;
      area.closest('details').open = true;
      const note = flow.querySelector('.factsNote');
      if (note) note.textContent = m.note || '';
    }
  });
`;

// ── The extension's side of the setup region (VS Code-free, tested under node) ──

/** A goal as the init message carries it: what the picker shows, plus the object concept's data type. */
export interface PanelGoal extends Goal {
  /** "string" | "number" | "date" | "truth": the object concept's type, which the results region formats values with. */
  objectType: string;
}

export interface PanelGoalList {
  /** One goal per declared relationship, in document order. */
  goals: PanelGoal[];
  /** True when the map has askable and askable="none" relationships (only then is "not askable" worth a tag). */
  askableMixed: boolean;
}

/** The engine's type for a concept: the legacy "boolean" is "truth"; an undeclared concept or an unknown type is a string. */
function conceptType(type: string | undefined): string {
  if (type === "number" || type === "date" || type === "truth") return type;
  return type === "boolean" ? "truth" : "string";
}

/** The init message's goal list for a map's RBLang: the open file's text, or the platform draft's. */
export function panelGoals(text: string): PanelGoalList {
  const index = buildIndex(text);
  const list = goalsFromIndex(index);
  return {
    goals: list.goals.map((g) => ({ ...g, objectType: conceptType(index.concepts.get(g.object)?.type) })),
    askableMixed: list.askableMixed,
  };
}

/**
 * The goal to prefill: the relationship at the cursor (or from a CodeLens), in
 * the map's declared spelling, when the map declares it (any name when there is
 * no goal list to check); else the last goal run against this map, when the map
 * still declares it.
 */
export function preselectGoal(
  goals: readonly { name: string; subject: string; object: string }[],
  cursor: string | undefined,
  remembered: string | undefined
): { goal: string; from: "editor" | "last" } | undefined {
  const atCursor = cursor?.trim();
  if (atCursor) {
    if (!goals.length) return { goal: atCursor, from: "editor" };
    const name = goals.some((g) => g.name === atCursor) ? atCursor : canonicalGoal(goals, atCursor);
    if (name) return { goal: name, from: "editor" };
  }
  if (remembered && goals.some((g) => g.name === remembered)) return { goal: remembered, from: "last" };
  return undefined;
}

/** How many maps keep a remembered goal (globalState "rainbird.lastGoals.<apiUrl>"), as many as the Maps registry keeps. */
export const LAST_GOALS_CAP = 100;

/** The stored kmID → goal pairs, most recent first; anything malformed reads as none. */
function lastGoalEntries(stored: unknown): [string, string][] {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
  return Object.entries(stored as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""
  );
}

/**
 * The remembered goals with `goal` recorded for `kmId`: that map first, then
 * the others, most recent first, at most `cap` maps. Keys are normalised kmIDs
 * (GUIDs, which JavaScript keeps in insertion order; a purely numeric ID would
 * be listed first, which only changes which entry the cap drops).
 */
export function withLastGoal(stored: unknown, kmId: string, goal: string, cap: number = LAST_GOALS_CAP): Record<string, string> {
  const id = normaliseKmId(kmId);
  const others = lastGoalEntries(stored).filter(([key]) => normaliseKmId(key) !== id);
  return Object.fromEntries([[id, goal] as [string, string], ...others].slice(0, Math.max(0, cap)));
}

/** The goal last run against kmId, when the map still declares it (a renamed or deleted relationship is not offered). */
export function lastGoalFor(stored: unknown, kmId: string, goals: readonly { name: string }[]): string | undefined {
  const id = normaliseKmId(kmId);
  const hit = lastGoalEntries(stored).find(([key]) => normaliseKmId(key) === id);
  return hit && goals.some((g) => g.name === hit[1]) ? hit[1] : undefined;
}

/**
 * What the panel adds to the engine's bare "400 Bad request!" when /query names
 * a relationship the map does not have (an unknown and a case-mismatched name
 * get the same answer): names are case-sensitive, where the goal list came
 * from, and how to reach the right map. Pushing or binding is suggested only
 * when the panel queries a file that can be pushed or bound; otherwise
 * “Change…” beside the map picks another Knowledge Map ID.
 */
export function unknownGoalNote(opts: {
  kmId: string;
  relationship: string;
  /** Where the goal list came from: "editor" (the file), "platform" (the draft) or "none". */
  goalsFrom: string;
  /** The panel queries a file the user can push or bind: not a map chosen by ID, nor a read-only platform or snapshot document. */
  file: boolean;
  /** The session's target: a live or saved version may lack relationships the goal list shows. */
  target?: StartTarget;
}): string {
  const { kmId, relationship, goalsFrom, file, target } = opts;
  const ranAgainst = target?.kind === "live" ? "the live version" : target?.kind === "version" ? `version ${target.version}` : undefined;
  return [
    `The map (${kmId}) has no relationship named exactly "${relationship}" — names are case-sensitive.`,
    ranAgainst && goalsFrom !== "none" ? `This query ran against ${ranAgainst}, which may not have every relationship the goal list shows.` : "",
    goalsFrom === "editor"
      ? "The goal list comes from your open .rbl file; check the map name in the header above."
      : "Check the map name in the header above.",
    file
      ? "If it's a different map, push the open file first (cloud icon), or point the file at the right map: " +
        "click “Change…” beside the map in the header, or run “Rainbird: Bind Open File to a Knowledge Map ID…”."
      : "If it's a different map, click “Change…” beside the map in the header to query another Knowledge Map ID.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The error card when the kmID prompt was cancelled, so the panel has no new
 * map. `current`: the map the panel still queries, if any. `file`: the file
 * whose map was asked for. `retry`: “Change…” (“Choose map…” before any map)
 * now asks for that file's map again, rather than for any map by ID.
 */
export function noMapNote(opts: { current?: string; file?: string; retry?: boolean }): string {
  const forFile = opts.file && opts.retry ? opts.file : undefined;
  if (!opts.current) {
    return forFile
      ? `No map chosen for ${forFile}. Click “Choose map…” at the top to pick one.`
      : "No map chosen. Click “Choose map…” at the top, or open the map's .rbl file and press ▶ in its title bar.";
  }
  return forFile
    ? `No map chosen for ${forFile}, so the panel still queries ${opts.current}. Click “Change…” at the top to pick one for it.`
    : `No map chosen, so the panel still queries ${opts.current}. Click “Change…” at the top to pick another.`;
}
