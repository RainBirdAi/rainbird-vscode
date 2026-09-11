/**
 * Knowledge-map graph view: renders the open RBLang file as an interactive
 * force-directed graph — concepts as typed nodes, relationships as labelled
 * edges (with rule/fact counts), instances orbiting their concepts. Clicking
 * anything jumps to its source line; the graph re-renders live as you type.
 */
import * as vscode from "vscode";
import { buildIndex } from "./mapIndex";

interface GraphNode {
  id: string;
  label: string;
  kind: "concept" | "instance";
  ctype?: string;
  offset: number;
}

interface GraphEdge {
  from: string;
  to: string;
  kind: "rel" | "instanceOf";
  label?: string;
  offset?: number;
  rules?: number;
  facts?: number;
}

/** Evidence projected onto the graph: the relationships/instances a decision actually used. */
export interface EvidenceOverlay {
  rels: { name: string; certainty: number }[];
  instances: string[];
}

export class GraphView {
  private static current?: GraphView;

  private doc?: vscode.TextDocument;
  private debounce?: NodeJS.Timeout;
  private ready = false;
  private readonly queue: unknown[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  static open(_context?: vscode.ExtensionContext): void {
    const editor =
      vscode.window.activeTextEditor?.document.languageId === "rblang"
        ? vscode.window.activeTextEditor
        : vscode.window.visibleTextEditors.find((e) => e.document.languageId === "rblang");
    if (GraphView.current) {
      GraphView.current.panel.reveal(vscode.ViewColumn.Beside, true);
      if (editor) GraphView.current.track(editor.document);
      return;
    }
    if (!editor) {
      vscode.window.showInformationMessage("Open an RBLang (.rbl) file to visualise it as a graph.");
      return;
    }
    const panel = vscode.window.createWebviewPanel("rainbirdGraph", "Rainbird Graph", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    GraphView.current = new GraphView(panel);
    GraphView.current.track(editor.document);
  }

  /** Highlight the inference path of a decision (opens the graph if needed). */
  static showOverlay(overlay: EvidenceOverlay): void {
    if (!GraphView.current) GraphView.open();
    if (!GraphView.current) return; // no rblang editor visible — open() already told the user
    GraphView.current.panel.reveal(vscode.ViewColumn.Beside, true);
    GraphView.current.post({ type: "overlay", overlay });
  }

  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.webview.html = render();
    panel.onDidDispose(() => {
      this.disposables.forEach((d) => d.dispose());
      GraphView.current = undefined;
    });

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.doc) this.scheduleUpdate();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === "rblang" && editor.document !== this.doc) {
          this.track(editor.document);
        }
      })
    );

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "ready") {
        this.ready = true;
        for (const queued of this.queue.splice(0)) void panel.webview.postMessage(queued);
        return;
      }
      if (msg.type === "reveal" && this.doc) {
        const position = this.doc.positionAt(Number(msg.offset) || 0);
        const editor = await vscode.window.showTextDocument(this.doc, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false,
        });
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
    });
  }

  private track(doc: vscode.TextDocument): void {
    this.doc = doc;
    this.panel.title = `Graph: ${doc.uri.path.split("/").pop()}`;
    this.update();
  }

  private scheduleUpdate(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.update(), 400);
  }

  private post(message: unknown): void {
    if (this.ready) void this.panel.webview.postMessage(message);
    else this.queue.push(message);
  }

  private update(): void {
    if (!this.doc) return;
    const graph = computeGraph(this.doc.getText());
    this.post({ type: "graph", ...graph });
  }
}

export function computeGraph(text: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const index = buildIndex(text);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const [name, c] of index.concepts) {
    nodes.push({ id: `c:${name}`, label: name, kind: "concept", ctype: c.type, offset: c.offset });
  }
  for (const [name, inst] of index.instances) {
    nodes.push({ id: `i:${name}`, label: name, kind: "instance", offset: inst.offset });
    if (index.concepts.has(inst.type)) {
      edges.push({ from: `i:${name}`, to: `c:${inst.type}`, kind: "instanceOf" });
    }
  }

  const relEdges = new Map<string, GraphEdge>();
  for (const [name, rel] of index.relationships) {
    if (!index.concepts.has(rel.subject) || !index.concepts.has(rel.object)) continue;
    const edge: GraphEdge = {
      from: `c:${rel.subject}`,
      to: `c:${rel.object}`,
      kind: "rel",
      label: name,
      offset: rel.offset,
      rules: 0,
      facts: 0,
    };
    relEdges.set(name, edge);
    edges.push(edge);
  }

  // Count facts vs rules per relationship by scanning relinst nesting.
  for (let i = 0; i < index.tags.length; i++) {
    const tag = index.tags[i];
    if (tag.closing || tag.name !== "relinst") continue;
    const edge = relEdges.get(tag.attrs.type ?? "");
    if (!edge) continue;
    let hasCondition = false;
    if (!tag.selfClosing) {
      for (let j = i + 1; j < index.tags.length; j++) {
        const inner = index.tags[j];
        if (inner.name === "relinst" && inner.closing) break;
        if (inner.name === "condition" && !inner.closing) {
          hasCondition = true;
          break;
        }
      }
    }
    if (hasCondition) edge.rules = (edge.rules ?? 0) + 1;
    else edge.facts = (edge.facts ?? 0) + 1;
  }

  return { nodes, edges };
}

export function render(): string {
  const nonce = String(Math.random()).slice(2);
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; overflow: hidden; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  svg { width: 100vw; height: 100vh; cursor: grab; }
  svg.panning { cursor: grabbing; }
  .edge { stroke: var(--vscode-editorLineNumber-foreground, #888); stroke-opacity: .55; }
  .edge.instanceOf { stroke-dasharray: 3 3; stroke-opacity: .3; }
  .edgelabel { font-size: 10px; fill: var(--vscode-descriptionForeground); cursor: pointer; user-select: none; }
  .edgelabel:hover { fill: var(--vscode-textLink-foreground); }
  .counts { font-size: 8.5px; fill: var(--vscode-descriptionForeground); opacity: .8; user-select: none; }
  .node { cursor: pointer; }
  .node text { font-size: 11px; fill: var(--vscode-foreground); user-select: none; }
  .node.instance text { font-size: 9px; opacity: .75; }
  .node:hover circle { stroke: var(--vscode-focusBorder); stroke-width: 2; }
  #legend { position: fixed; bottom: 8px; left: 10px; font-size: 10.5px; opacity: .75; user-select: none; }
  #legend span { display: inline-flex; align-items: center; margin-right: .8em; gap: .3em; }
  #legend i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  #hint { position: fixed; top: 8px; right: 12px; font-size: 10.5px; opacity: .5; user-select: none; }
  #emptymsg { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; opacity: .6; }
  line.hot { stroke: var(--vscode-charts-orange, #e8590c); stroke-width: 2.4; stroke-opacity: .95; }
  text.hot { fill: var(--vscode-charts-orange, #e8590c); font-weight: 600; }
  .node.hot circle { stroke: var(--vscode-charts-orange, #e8590c); stroke-width: 2.5; }
  .dimmed { opacity: .13; }
  #clearOverlay { position: fixed; top: 8px; left: 10px; display: none; font-size: 11px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 4px; padding: .25rem .6rem; }
</style>
</head>
<body>
<svg id="svg"><g id="world"><g id="edges"></g><g id="nodes"></g></g></svg>
<div id="legend">
  <span><i style="background:#4d8fd1"></i>string</span>
  <span><i style="background:#73c991"></i>number</span>
  <span><i style="background:#e2b93d"></i>date</span>
  <span><i style="background:#b180d7"></i>truth</span>
  <span><i style="background:#8b8b8b;width:6px;height:6px"></i>instance</span>
</div>
<div id="hint">click = jump to source · drag nodes · wheel = zoom</div>
<div id="emptymsg">No concepts yet — declare a &lt;concept&gt; to see the graph.</div>
<button id="clearOverlay">✕ evidence overlay</button>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const svg = document.getElementById('svg');
  const world = document.getElementById('world');
  const edgesG = document.getElementById('edges');
  const nodesG = document.getElementById('nodes');
  const CTYPE = { string:'#4d8fd1', number:'#73c991', date:'#e2b93d', truth:'#b180d7' };
  const NS = 'http://www.w3.org/2000/svg';

  let nodes = [], edges = [], pos = new Map(), alpha = 0;
  let view = { x: 0, y: 0, k: 1 };
  let dragging = null, panning = null, moved = 0;
  let overlay = null;

  function applyOverlay() {
    const btn = document.getElementById('clearOverlay');
    if (!overlay) {
      btn.style.display = 'none';
      for (const e of edges) {
        if (e._line) e._line.classList.remove('hot', 'dimmed');
        if (e._label) { e._label.classList.remove('hot', 'dimmed'); e._label.textContent = e.label; }
        if (e._badge) e._badge.classList.remove('dimmed');
      }
      for (const n of nodes) if (n._g) n._g.classList.remove('hot', 'dimmed');
      return;
    }
    btn.style.display = 'block';
    const hotRels = new Map(overlay.rels.map(r => [r.name, r.certainty]));
    const hotInstances = new Set(overlay.instances);
    const hotNodeIds = new Set();
    for (const e of edges) {
      const hot = e.kind === 'rel' && hotRels.has(e.label);
      if (hot) { hotNodeIds.add(e.from); hotNodeIds.add(e.to); }
    }
    for (const n of nodes) {
      if (n.kind === 'instance' && hotInstances.has(n.label)) hotNodeIds.add(n.id);
    }
    for (const e of edges) {
      const hot = e.kind === 'rel' ? hotRels.has(e.label)
        : hotNodeIds.has(e.from) && hotNodeIds.has(e.to);
      if (e._line) { e._line.classList.toggle('hot', hot); e._line.classList.toggle('dimmed', !hot); }
      if (e._label) {
        e._label.classList.toggle('hot', hot);
        e._label.classList.toggle('dimmed', !hot);
        const cf = hotRels.get(e.label);
        e._label.textContent = hot && cf ? e.label + ' · ' + cf + '%' : e.label;
      }
      if (e._badge) e._badge.classList.toggle('dimmed', !hot);
    }
    for (const n of nodes) {
      const hot = hotNodeIds.has(n.id);
      if (n._g) { n._g.classList.toggle('hot', hot); n._g.classList.toggle('dimmed', !hot); }
    }
  }
  document.getElementById('clearOverlay').addEventListener('click', () => { overlay = null; applyOverlay(); });

  function applyView() {
    world.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
  }

  function setGraph(m) {
    nodes = m.nodes; edges = m.edges;
    document.getElementById('emptymsg').style.display = nodes.length ? 'none' : 'flex';
    const w = innerWidth, h = innerHeight;
    const seen = new Set();
    for (const n of nodes) {
      seen.add(n.id);
      if (!pos.has(n.id)) {
        pos.set(n.id, { x: w/2 + (Math.random()-0.5)*w*0.5, y: h/2 + (Math.random()-0.5)*h*0.5, vx: 0, vy: 0 });
      }
    }
    for (const id of [...pos.keys()]) if (!seen.has(id)) pos.delete(id);
    build();
    applyOverlay();
    alpha = 1;
  }

  function build() {
    edgesG.innerHTML = ''; nodesG.innerHTML = '';
    for (const e of edges) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('class', 'edge ' + e.kind);
      e._line = line;
      edgesG.appendChild(line);
      if (e.kind === 'rel') {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('class', 'edgelabel');
        t.setAttribute('text-anchor', 'middle');
        t.textContent = e.label;
        t.addEventListener('click', () => vscode.postMessage({ type: 'reveal', offset: e.offset }));
        e._label = t;
        edgesG.appendChild(t);
        const badge = [];
        if (e.rules) badge.push(e.rules + ' rule' + (e.rules>1?'s':''));
        if (e.facts) badge.push(e.facts + ' fact' + (e.facts>1?'s':''));
        if (badge.length) {
          const b = document.createElementNS(NS, 'text');
          b.setAttribute('class', 'counts');
          b.setAttribute('text-anchor', 'middle');
          b.textContent = badge.join(' · ');
          e._badge = b;
          edgesG.appendChild(b);
        }
      }
    }
    for (const n of nodes) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'node ' + n.kind);
      const c = document.createElementNS(NS, 'circle');
      const r = n.kind === 'concept' ? 16 : 6;
      c.setAttribute('r', r);
      c.setAttribute('fill', n.kind === 'concept' ? (CTYPE[n.ctype] || '#4d8fd1') : '#8b8b8b');
      c.setAttribute('fill-opacity', n.kind === 'concept' ? '0.9' : '0.7');
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dy', n.kind === 'concept' ? r + 13 : r + 10);
      t.textContent = n.label;
      g.appendChild(c); g.appendChild(t);
      n._g = g;
      nodesG.appendChild(g);

      g.addEventListener('pointerdown', ev => {
        ev.stopPropagation();
        dragging = n; moved = 0;
        g.setPointerCapture(ev.pointerId);
      });
      g.addEventListener('pointermove', ev => {
        if (dragging !== n) return;
        moved++;
        const p = pos.get(n.id);
        p.x += ev.movementX / view.k; p.y += ev.movementY / view.k;
        p.vx = p.vy = 0;
        alpha = Math.max(alpha, 0.3);
      });
      g.addEventListener('pointerup', () => {
        if (dragging === n && moved < 3) vscode.postMessage({ type: 'reveal', offset: n.offset });
        dragging = null;
      });
    }
  }

  function tick() {
    if (alpha > 0.005 && nodes.length) {
      const w = innerWidth, h = innerHeight;
      for (const a of nodes) {
        const pa = pos.get(a.id);
        for (const b of nodes) {
          if (a === b) continue;
          const pb = pos.get(b.id);
          let dx = pa.x - pb.x, dy = pa.y - pb.y;
          let d2 = dx*dx + dy*dy || 1;
          if (d2 < 250000) {
            const f = (a.kind === 'concept' && b.kind === 'concept' ? 2600 : 700) / d2;
            pa.vx += dx * f * alpha; pa.vy += dy * f * alpha;
          }
        }
        pa.vx += (w/2 - pa.x) * 0.0012 * alpha;
        pa.vy += (h/2 - pa.y) * 0.0012 * alpha;
      }
      for (const e of edges) {
        const pa = pos.get(e.from), pb = pos.get(e.to);
        if (!pa || !pb) continue;
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const d = Math.sqrt(dx*dx + dy*dy) || 1;
        const rest = e.kind === 'rel' ? 190 : 55;
        const f = (d - rest) / d * 0.02 * alpha * (e.kind === 'rel' ? 1 : 2.2);
        pa.vx += dx * f; pa.vy += dy * f;
        pb.vx -= dx * f; pb.vy -= dy * f;
      }
      for (const n of nodes) {
        const p = pos.get(n.id);
        if (dragging === n) continue;
        p.x += (p.vx *= 0.85); p.y += (p.vy *= 0.85);
      }
      alpha *= 0.985;
      draw();
    }
    requestAnimationFrame(tick);
  }

  function draw() {
    for (const e of edges) {
      const pa = pos.get(e.from), pb = pos.get(e.to);
      if (!pa || !pb) continue;
      e._line.setAttribute('x1', pa.x); e._line.setAttribute('y1', pa.y);
      e._line.setAttribute('x2', pb.x); e._line.setAttribute('y2', pb.y);
      if (e._label) {
        e._label.setAttribute('x', (pa.x + pb.x) / 2);
        e._label.setAttribute('y', (pa.y + pb.y) / 2 - 4);
      }
      if (e._badge) {
        e._badge.setAttribute('x', (pa.x + pb.x) / 2);
        e._badge.setAttribute('y', (pa.y + pb.y) / 2 + 8);
      }
    }
    for (const n of nodes) {
      const p = pos.get(n.id);
      n._g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
    }
  }

  svg.addEventListener('pointerdown', ev => {
    panning = { x: ev.clientX, y: ev.clientY };
    svg.classList.add('panning');
  });
  svg.addEventListener('pointermove', ev => {
    if (!panning || dragging) return;
    view.x += ev.clientX - panning.x; view.y += ev.clientY - panning.y;
    panning = { x: ev.clientX, y: ev.clientY };
    applyView();
  });
  svg.addEventListener('pointerup', () => { panning = null; svg.classList.remove('panning'); });
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const k = Math.min(3, Math.max(0.25, view.k * (ev.deltaY < 0 ? 1.1 : 0.9)));
    // Zoom around the cursor.
    view.x = ev.clientX - (ev.clientX - view.x) * (k / view.k);
    view.y = ev.clientY - (ev.clientY - view.y) * (k / view.k);
    view.k = k;
    applyView();
  }, { passive: false });

  window.addEventListener('message', e => {
    if (e.data.type === 'graph') setGraph(e.data);
    else if (e.data.type === 'overlay') { overlay = e.data.overlay; applyOverlay(); }
  });
  vscode.postMessage({ type: 'ready' });
  tick();
</script>
</body>
</html>`;
}
