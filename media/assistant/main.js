// Webview script for the Rainbird AI Assistant. Renders the conversation
// (markdown, code blocks with lint badges, tool activity, change cards) and
// relays user actions to the extension. No framework, no external resources.
(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const statusText = document.getElementById("statusText");
  const usageEl = document.getElementById("usage");
  const chipsEl = document.getElementById("chips");

  let state = { hasKey: false, model: "", effort: "", applyMode: "immediately", target: null };
  let busy = false;
  let turn = null; // { el, items: [], textEl, thinkingEl, toolsEl, toolsList, tools: Map }

  // ---------------------------------------------------------------- helpers

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function scroll() {
    log.scrollTop = log.scrollHeight;
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // Minimal markdown: fenced code (kept as placeholders), headings, lists, bold/italic, inline code, paragraphs.
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  }

  function renderMarkdown(text, lints) {
    const blocks = [];
    const withPlaceholders = text.replace(/```([\w-]*)[ \t]*\n([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push({ lang, code: code.replace(/\n$/, "") });
      return `\u0000${blocks.length - 1}\u0000`;
    });
    // Unterminated fence while streaming: show the tail as code too.
    const openFence = withPlaceholders.match(/```([\w-]*)[ \t]*\n([\s\S]*)$/);
    let body = withPlaceholders;
    if (openFence) {
      blocks.push({ lang: openFence[1], code: openFence[2], partial: true });
      body = withPlaceholders.slice(0, openFence.index) + `\u0000${blocks.length - 1}\u0000`;
    }

    const lines = body.split("\n");
    let html = "";
    let list = null; // "ul" | "ol"
    let para = [];
    const flushPara = () => {
      if (para.length) html += `<p>${inline(para.join(" "))}</p>`;
      para = [];
    };
    const closeList = () => {
      if (list) html += `</${list}>`;
      list = null;
    };
    let codeIndex = 0;
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const ph = /^\u0000(\d+)\u0000$/.exec(line.trim());
      if (ph) {
        flushPara();
        closeList();
        const b = blocks[Number(ph[1])];
        const isCode = /^(rblang|xml)?$/.test(b.lang || "");
        const lint = isCode && lints ? lints[codeIndex] : null;
        if (isCode) codeIndex++;
        html += codeBlock(b, lint);
        continue;
      }
      if (!line.trim()) {
        flushPara();
        closeList();
        continue;
      }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        flushPara();
        closeList();
        html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
        continue;
      }
      const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        const kind = /^\s*\d/.test(line) ? "ol" : "ul";
        if (list !== kind) {
          closeList();
          html += `<${kind}>`;
          list = kind;
        }
        html += `<li>${inline(li[1])}</li>`;
        continue;
      }
      if (list && /^\s{2,}/.test(raw)) {
        // continuation of a list item
        html = html.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
        continue;
      }
      closeList();
      para.push(line.trim());
    }
    flushPara();
    closeList();
    return html || "";
  }

  function codeBlock(b, lint) {
    const code = b.code;
    const enc = encodeURIComponent(code);
    let lintHtml = "";
    let bar = "";
    if (b.partial) {
      lintHtml = '<div class="lint">…</div>';
    } else if (lint) {
      const errs = lint.issues.filter((x) => x.severity === "error");
      const warns = lint.issues.filter((x) => x.severity === "warning");
      if (!lint.issues.length) lintHtml = '<div class="lint ok">✓ passes the RBLang linter</div>';
      else if (!errs.length) lintHtml = `<div class="lint warn">⚠ ${warns.length} warning${warns.length === 1 ? "" : "s"}<ul>${warns.map((x) => `<li>line ${x.line + 1}: ${esc(x.message)}</li>`).join("")}</ul></div>`;
      else lintHtml = `<div class="lint bad">✗ ${errs.length} error${errs.length === 1 ? "" : "s"}<ul>${errs.map((x) => `<li>line ${x.line + 1}: ${esc(x.message)}</li>`).join("")}</ul></div>`;
      bar =
        `<div class="codebar">` +
        `<button data-act="insert" data-code="${enc}" title="Insert at the cursor (or replace the selection)">Insert</button>` +
        (lint.complete ? `<button data-act="replaceFile" data-code="${enc}" title="Replace the whole open file with this map">Replace file</button>` : "") +
        `<button data-act="copy" data-code="${enc}">Copy</button>` +
        (errs.length ? `<button data-act="fix" data-issues="${encodeURIComponent(JSON.stringify(errs.map((x) => `line ${x.line + 1}: ${x.message}`)))}">Ask to fix</button>` : "") +
        `</div>`;
    } else if (!/^(rblang|xml)?$/.test(b.lang || "")) {
      bar = `<div class="codebar"><button data-act="copy" data-code="${enc}">Copy</button></div>`;
    }
    return `<div class="codewrap"><pre>${esc(code)}</pre>${bar}${lintHtml}</div>`;
  }

  // ---------------------------------------------------------------- state & chips

  const CHIPS_WITH_MAP = [
    ["Explain this map", "Explain what this map decides, which rules fire when, what the engine will ask, and how certainty flows."],
    ["Find & fix problems", "Review this map for problems (diagnostics, unreachable rules, missing question wording, precedence traps, weak evidence text) and fix them."],
    ["Add a rule…", "Add a rule that "],
    ["Add question wording", "Add natural question wording to every askable relationship that is missing it, in the same voice as the existing questions."],
    ["Review certainty", "Review the certainty design of this map: rule cf values, condition weights, optional conditions and minimum-rule-certainty. Suggest improvements and apply the uncontroversial ones."],
  ];
  const CHIPS_NO_MAP = [
    ["Create a map…", "Create a knowledge map that decides "],
    ["What can I ask?", "What can you help me with in this extension, and what do I need set up?"],
  ];

  function renderChips() {
    const chips = state.target ? CHIPS_WITH_MAP : CHIPS_NO_MAP;
    chipsEl.innerHTML = chips.map(([label, fill]) => `<button class="chip" data-fill="${esc(fill)}">${esc(label)}</button>`).join("");
  }

  function renderEmpty() {
    const e = document.getElementById("empty");
    if (!e) return;
    const target = state.target ? `<strong>${esc(state.target.name)}</strong> is open.` : "Open a <code>.rbl</code> file, or ask for a new map.";
    const key = state.hasKey ? "" : `<p><button class="primary" data-act="setKey">Set Anthropic API key</button> to get started.</p>`;
    e.innerHTML =
      `<p>${target} Ask anything about the knowledge map, or describe a change — the assistant reads the map, edits it through validated operations and reports what changed.</p>` +
      `<ul><li>“Which rules infer <em>has risk level</em>, and what do they ask for?”</li><li>“Add a rule: applicants over 65 are exempt from the income check.”</li><li>“Why would this map never ask about postcode?”</li></ul>` +
      key;
  }

  function renderStatus() {
    if (busy) {
      statusText.textContent = "Working…";
      return;
    }
    const mode = state.applyMode === "preview" ? "edits previewed" : "edits applied directly";
    statusText.innerHTML = `${esc(state.model)} · ${esc(state.effort)} effort · ${mode} · <a data-act="openSettings">settings</a>`;
  }

  function setBusy(b) {
    busy = b;
    sendBtn.textContent = b ? "Stop" : "Send";
    sendBtn.title = b ? "Stop the current turn" : "Send (Enter)";
    renderStatus();
  }

  // ---------------------------------------------------------------- a turn's rendering

  function startTurn(turnId) {
    const wrap = el("div", "msg assistant");
    wrap.dataset.turnId = turnId;
    const thinkingEl = el("div", "thinking-text");
    thinkingEl.style.display = "none";
    const toolsEl = el("details", "tools");
    toolsEl.open = true;
    toolsEl.style.display = "none";
    const summary = el("summary", "", "Working…");
    const toolsList = el("div");
    toolsEl.appendChild(summary);
    toolsEl.appendChild(toolsList);
    const textEl = el("div", "text", '<p class="thinking">Thinking…</p>');
    wrap.appendChild(thinkingEl);
    wrap.appendChild(toolsEl);
    wrap.appendChild(textEl);
    log.appendChild(wrap);
    turn = { el: wrap, thinkingEl, toolsEl, toolsSummary: summary, toolsList, textEl, text: "", thinking: "", tools: new Map() };
    scroll();
  }

  const TOOL_ICON = { pending: "◌", running: "◐", done: "✓", error: "✗" };

  function renderTool(event) {
    if (!turn) return;
    turn.toolsEl.style.display = "";
    let row = turn.tools.get(event.id);
    if (!row) {
      row = el("div", "tool");
      turn.toolsList.appendChild(row);
      turn.tools.set(event.id, row);
    }
    row.className = `tool ${event.status}`;
    const detail = event.detail && event.status !== "running" ? `<span class="detail">— ${esc(event.detail)}</span>` : "";
    row.innerHTML = `<span class="icon">${TOOL_ICON[event.status] || "·"}</span><span>${esc(event.label)}</span>${detail}`;
    const n = turn.tools.size;
    turn.toolsSummary.textContent = busy ? `Working… (${n} step${n === 1 ? "" : "s"})` : `${n} step${n === 1 ? "" : "s"}`;
    scroll();
  }

  function renderStreaming() {
    if (!turn) return;
    if (turn.thinking && !turn.text) {
      turn.thinkingEl.style.display = "";
      turn.thinkingEl.textContent = turn.thinking.slice(-600);
    }
    if (turn.text) {
      turn.thinkingEl.style.display = "none";
      turn.textEl.innerHTML = renderMarkdown(turn.text, null);
    }
    scroll();
  }

  function finishTurn(m) {
    if (!turn) return;
    turn.thinkingEl.style.display = "none";
    turn.textEl.innerHTML = renderMarkdown(m.text || "", m.lints || []);
    if (turn.tools.size) {
      turn.toolsEl.open = false;
      turn.toolsSummary.textContent = `${turn.tools.size} step${turn.tools.size === 1 ? "" : "s"}`;
    } else {
      turn.toolsEl.style.display = "none";
    }
    if (m.changes) {
      const card = el("div", `changes${m.proposal ? " proposal" : ""}`);
      const title = m.proposal ? `Proposed changes to ${esc(m.changes.fileName)} — review the diff, then:` : `Changes to ${esc(m.changes.fileName)}`;
      const items = m.changes.summary.slice(0, 12).map((s) => `<li>${esc(s)}</li>`).join("") + (m.changes.summary.length > 12 ? `<li>… ${m.changes.summary.length - 12} more</li>` : "");
      const bar = m.proposal
        ? `<button class="primary" data-act="acceptProposal" data-turn="${m.turnId}">Accept</button><button data-act="rejectProposal" data-turn="${m.turnId}">Reject</button>`
        : `${m.changes.canShowDiff ? `<button data-act="showDiff" data-turn="${m.turnId}">Show diff</button>` : ""}${m.changes.canUndo ? `<button data-act="undoTurn" data-turn="${m.turnId}">Undo this turn</button>` : ""}`;
      card.innerHTML = `<div class="title">${title}</div><ul>${items}</ul><div class="bar">${bar}</div>`;
      turn.el.appendChild(card);
    }
    if (m.truncated) turn.el.appendChild(el("div", "notice", "The reply was cut off by the output limit. Ask to continue."));
    if (m.roundCapHit) turn.el.appendChild(el("div", "notice", "The assistant used its tool budget for this turn and wrapped up. Ask it to continue if work remains."));
    if (m.usage) {
      const u = m.usage;
      const cache = u.cacheRead ? ` · ${Math.round((u.cacheRead / Math.max(1, u.cacheRead + u.input)) * 100)}% cached` : "";
      usageEl.textContent = `${fmt(u.input + u.cacheRead)} in · ${fmt(u.output)} out${cache}`;
    }
    turn = null;
    scroll();
  }

  function fmt(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  // ---------------------------------------------------------------- events

  function send(text) {
    if (busy) {
      vscode.postMessage({ type: "stop" });
      return;
    }
    text = (text ?? input.value).trim();
    if (!text) return;
    input.value = "";
    vscode.postMessage({ type: "send", text });
  }

  sendBtn.addEventListener("click", () => send());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  chipsEl.addEventListener("click", (e) => {
    const fill = e.target && e.target.dataset && e.target.dataset.fill;
    if (!fill) return;
    if (/[…:]\s*$|\s$/.test(fill)) {
      input.value = fill;
      input.focus();
    } else {
      send(fill);
    }
  });
  document.body.addEventListener("click", (e) => {
    const t = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!t) return;
    const act = t.dataset.act;
    if (act === "fix") {
      const issues = JSON.parse(decodeURIComponent(t.dataset.issues));
      send("The RBLang you showed has lint errors — fix them:\n" + issues.join("\n"));
    } else if (act === "insert" || act === "replaceFile" || act === "copy") {
      vscode.postMessage({ type: act, code: decodeURIComponent(t.dataset.code) });
    } else if (act === "showDiff" || act === "undoTurn" || act === "acceptProposal" || act === "rejectProposal") {
      vscode.postMessage({ type: act, turnId: t.dataset.turn });
      if (act === "acceptProposal" || act === "rejectProposal") t.parentElement.querySelectorAll("button").forEach((b) => (b.disabled = true));
    } else {
      vscode.postMessage({ type: act });
    }
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "state":
        state = m;
        renderChips();
        renderEmpty();
        renderStatus();
        break;
      case "user": {
        const empty = document.getElementById("empty");
        if (empty) empty.remove();
        const div = el("div", "msg user");
        div.textContent = m.text;
        if (m.contextNote) div.appendChild(el("div", "ctx", esc(m.contextNote)));
        log.appendChild(div);
        scroll();
        break;
      }
      case "start":
        setBusy(true);
        startTurn(m.turnId);
        break;
      case "thinking":
        if (turn) {
          turn.thinking += m.text;
          renderStreaming();
        }
        break;
      case "delta":
        if (turn) {
          turn.text += m.text;
          renderStreaming();
        }
        break;
      case "tool":
        renderTool(m.event);
        break;
      case "done":
        setBusy(false);
        if (!turn) startTurn(m.turnId);
        if (!m.text && !m.changes) {
          turn.el.remove();
          turn = null;
        } else {
          finishTurn(m);
        }
        break;
      case "error": {
        setBusy(false);
        if (turn && !turn.text && !turn.tools.size) turn.el.remove();
        else if (turn) {
          turn.textEl.innerHTML = renderMarkdown(turn.text, []);
          turn.thinkingEl.style.display = "none";
        }
        turn = null;
        const div = el("div", "msg error");
        div.textContent = m.message;
        if (m.action === "setKey") div.appendChild(el("button", "", "Set API key")).dataset.act = "setKey";
        if (m.action === "settings") div.appendChild(el("button", "", "Open settings")).dataset.act = "openSettings";
        log.appendChild(div);
        scroll();
        break;
      }
      case "hint":
        log.appendChild(el("div", "hint", esc(m.text)));
        scroll();
        break;
      case "reset":
        setBusy(false);
        turn = null;
        log.innerHTML = '<div id="empty"></div>';
        usageEl.textContent = "";
        renderEmpty();
        break;
    }
  });

  renderChips();
  renderEmpty();
  renderStatus();
  vscode.postMessage({ type: "ready" });
})();
