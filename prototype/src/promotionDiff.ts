/**
 * Promotion diff: replay one scenario (a saved .rbtest.json or the query
 * panel's last session) against two versions of the same map — typically
 * draft vs live — and report what changed: results, certainties and, when
 * evidence is accessible, the facts, rules and condition impacts behind them.
 * Studio has no version diff; this is the "what changes if I Set Live now?"
 * answer, built entirely on the documented API.
 */
import * as vscode from "vscode";
import { EvidenceNode, RainbirdClient, ResultItem, StartTarget, describeTarget } from "./api";
import { getClient, getEvidenceKey } from "./queryRunner";
import { loadTestFile, replay, ReplayOutcome, Scenario, SessionRecord } from "./tests";

type Tree = EvidenceNode & { children?: Tree[] };

interface Side {
  target: StartTarget;
  outcome?: ReplayOutcome;
  error?: string;
  versionLabel?: string;
}

interface PickedScenario extends Scenario {
  label: string;
  defaultTarget?: StartTarget;
}

export async function promotionDiff(context: vscode.ExtensionContext, record?: SessionRecord): Promise<void> {
  const client = await getClient(context);
  if (!client) return;

  const scenario = await pickScenario(record);
  if (!scenario) return;
  const a = await pickTarget("Baseline (A) — what runs today", scenario.defaultTarget ?? { kind: "live" });
  if (!a) return;
  const b = await pickTarget("Candidate (B) — what you are about to promote", { kind: "draft" });
  if (!b) return;

  const evidenceKey = await getEvidenceKey(context);
  const report = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Rainbird: comparing ${describeTarget(a)} with ${describeTarget(b)}…`,
    },
    async () => {
      const [sideA, sideB] = await Promise.all([runSide(client, scenario, a), runSide(client, scenario, b)]);
      return buildReport(client, scenario, sideA, sideB, evidenceKey);
    }
  );

  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: report });
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
}

async function pickScenario(record?: SessionRecord): Promise<PickedScenario | undefined> {
  type Item = vscode.QuickPickItem & { scenario: PickedScenario };
  const items: Item[] = [];
  const goalText = (s: Scenario) =>
    `${s.goal.subject ?? "?"} ${s.goal.relationship} ${s.goal.object ?? "?"}`;

  if (record?.results) {
    items.push({
      label: "$(play) Last query panel session",
      description: goalText(record),
      detail: `${record.answers.length} answer batch${record.answers.length === 1 ? "" : "es"}${record.facts?.length ? `, ${record.facts.length} injected fact${record.facts.length === 1 ? "" : "s"}` : ""}`,
      scenario: { ...record, label: "last query panel session", defaultTarget: record.target },
    });
  }
  const files = await vscode.workspace.findFiles("**/*.rbtest.json", "**/node_modules/**");
  for (const file of files) {
    try {
      const test = await loadTestFile(file);
      items.push({
        label: `$(beaker) ${test.name}`,
        description: goalText(test),
        detail: vscode.workspace.asRelativePath(file),
        scenario: { ...test, label: `test "${test.name}"`, defaultTarget: test.target },
      });
    } catch {
      // Unreadable test file — skip it.
    }
  }
  if (!items.length) {
    vscode.window.showInformationMessage(
      "Nothing to compare yet — run a query in the Rainbird Query panel or save a test first. The diff replays a recorded scenario against two versions."
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: "Promotion diff — which scenario should run against both versions?",
    matchOnDescription: true,
  });
  return picked?.scenario;
}

async function pickTarget(title: string, preferred: StartTarget): Promise<StartTarget | undefined> {
  type Item = vscode.QuickPickItem & { targetKind: StartTarget["kind"] };
  const all: Item[] = [
    { label: "Draft", description: "the editable working copy", targetKind: "draft" },
    { label: "Live", description: "the version currently serving decisions", targetKind: "live" },
    { label: "Version number…", description: "a specific published version", targetKind: "version" },
  ];
  const ordered = [...all.filter((i) => i.targetKind === preferred.kind), ...all.filter((i) => i.targetKind !== preferred.kind)];
  const picked = await vscode.window.showQuickPick(ordered, { title, placeHolder: `Default: ${describeTarget(preferred)}` });
  if (!picked) return undefined;
  if (picked.targetKind !== "version") return { kind: picked.targetKind };
  const raw = await vscode.window.showInputBox({
    prompt: "Version number (from the map's Versions page in Studio)",
    value: preferred.kind === "version" ? String(preferred.version) : "",
    validateInput: (v) => (/^\d+$/.test(v.trim()) && Number(v) > 0 ? undefined : "Enter a positive whole number"),
  });
  if (!raw) return undefined;
  return { kind: "version", version: Number(raw.trim()) };
}

async function runSide(client: RainbirdClient, scenario: Scenario, target: StartTarget): Promise<Side> {
  const side: Side = { target };
  try {
    side.outcome = await replay(client, scenario, target);
    try {
      const info = await client.sessionInfo(side.outcome.sessionId);
      const km = (info.km ?? info.kmVersion ?? info) as Record<string, unknown>;
      const status = [km.versionStatus, info.versionStatus].find((v): v is string => typeof v === "string");
      const id = [km.versionID, km.versionId, km.id].find((v): v is string => typeof v === "string");
      side.versionLabel = [status, id ? `id ${id}` : undefined].filter(Boolean).join(", ") || undefined;
      // The engine falls back to the draft when a map has no live version — say so, or the
      // comparison silently becomes draft-vs-draft.
      if (target.kind === "live" && status === "Draft") side.versionLabel = "no live version — the engine served the draft";
    } catch {
      // Metadata is best-effort.
    }
  } catch (error) {
    side.error = (error as Error).message;
  }
  return side;
}

const key = (r: { subject: string; relationship: string; object: unknown }) => `${r.subject} ${r.relationship} ${r.object}`;
const delta = (a: number, b: number) => (b - a === 0 ? "—" : `${b - a > 0 ? "+" : ""}${b - a}`);

async function buildReport(
  client: RainbirdClient,
  scenario: PickedScenario,
  a: Side,
  b: Side,
  evidenceKey?: string
): Promise<string> {
  const labelA = `A = ${describeTarget(a.target)}${a.versionLabel ? ` (${a.versionLabel})` : ""}`;
  const labelB = `B = ${describeTarget(b.target)}${b.versionLabel ? ` (${b.versionLabel})` : ""}`;
  const goal = `${scenario.goal.subject ?? "?"} ${scenario.goal.relationship} ${scenario.goal.object ?? "?"}`;
  const lines: string[] = [
    `# Promotion diff — ${goal}`,
    "",
    `Map \`${scenario.kmId}\` · **${labelA}** · **${labelB}**`,
    "",
    `Scenario: ${scenario.label} — ${scenario.answers.length} recorded answer batch${scenario.answers.length === 1 ? "" : "es"}${scenario.facts?.length ? `, ${scenario.facts.length} injected fact${scenario.facts.length === 1 ? "" : "s"}` : ""}. Generated ${new Date().toISOString()}.`,
    "",
  ];

  // Sessions that could not complete.
  const problems: string[] = [];
  for (const [name, side] of [["A", a], ["B", b]] as const) {
    if (side.error) problems.push(`- **${name}** failed to run: ${side.error}`);
    else if (side.outcome?.pendingQuestion) {
      problems.push(
        `- **${name}** asked a question the scenario has no answer for: "${side.outcome.pendingQuestion.prompt}" — the question flow differs between versions, so results cannot be compared until the scenario is re-recorded.`
      );
    }
  }
  if (problems.length) lines.push("## Could not complete", "", ...problems, "");

  const resultsA = a.outcome?.results;
  const resultsB = b.outcome?.results;
  if (!resultsA || !resultsB) {
    lines.push("_No result comparison — both sides need to reach a result._");
    return lines.join("\n");
  }

  // Results table.
  const mapA = new Map(resultsA.map((r) => [key(r), r]));
  const mapB = new Map(resultsB.map((r) => [key(r), r]));
  const keys = [...new Set([...mapA.keys(), ...mapB.keys()])];
  let resultChanges = 0;
  lines.push("## Results", "", "| Fact | A | B | Δ |", "|---|---|---|---|");
  for (const k of keys) {
    const ra = mapA.get(k);
    const rb = mapB.get(k);
    if (ra && rb) {
      const changed = ra.certainty !== rb.certainty;
      if (changed) resultChanges++;
      lines.push(`| ${changed ? `**${k}**` : k} | ${ra.certainty}% | ${rb.certainty}% | ${delta(ra.certainty, rb.certainty)} |`);
    } else if (ra) {
      resultChanges++;
      lines.push(`| **${k}** | ${ra.certainty}% | _absent_ | removed in B |`);
    } else if (rb) {
      resultChanges++;
      lines.push(`| **${k}** | _absent_ | ${rb.certainty}% | new in B |`);
    }
  }
  if (!keys.length) lines.push("| _no results on either side_ | | | |");
  lines.push("");

  // Evidence: only for facts present on both sides.
  const shared = keys.filter((k) => mapA.has(k) && mapB.has(k));
  let evidenceChanges = 0;
  let evidenceLocked = false;
  const evidenceSections: string[] = [];
  for (const k of shared) {
    const ra = mapA.get(k)!;
    const rb = mapB.get(k)!;
    let treeA: Tree | undefined;
    let treeB: Tree | undefined;
    try {
      [treeA, treeB] = await Promise.all([
        client.fullEvidence(ra.factID, a.outcome!.sessionId, evidenceKey),
        client.fullEvidence(rb.factID, b.outcome!.sessionId, evidenceKey),
      ]);
    } catch (error) {
      if (/40[13]/.test((error as Error).message)) {
        evidenceLocked = true;
        break;
      }
      evidenceSections.push(`### ${k}`, "", `_Evidence could not be fetched: ${(error as Error).message}_`, "");
      continue;
    }
    const diff = diffEvidence(flatten(treeA), flatten(treeB));
    if (diff.length) {
      evidenceChanges += diff.length;
      evidenceSections.push(`### ${k}`, "", ...diff, "");
    }
  }

  lines.push("## Evidence", "");
  if (evidenceLocked) {
    lines.push(
      "_Evidence is locked for this map — enable the Evidence Tree Link in Studio (Publish → API Management → Access Control) or run “Rainbird: Set Evidence Key”, then re-run the diff to see which rules and conditions moved._",
      ""
    );
  } else if (!shared.length) {
    lines.push("_No fact is present on both sides, so there is nothing to compare at the evidence level._", "");
  } else if (!evidenceSections.length) {
    lines.push("_Identical evidence: the same facts, rules and impacts on both sides._", "");
  } else {
    lines.push(...evidenceSections);
  }

  const summary =
    resultChanges + evidenceChanges === 0 && !problems.length
      ? "**No differences.** B behaves identically to A for this scenario."
      : `**${resultChanges} result change${resultChanges === 1 ? "" : "s"}, ${evidenceChanges} evidence change${evidenceChanges === 1 ? "" : "s"}.**`;
  lines.splice(4, 0, summary, "");
  return lines.join("\n");
}

interface Flat {
  facts: Map<string, { source: string; certainty: number }>;
  conditions: Map<string, { impact?: number; salience?: number; wasMet?: boolean; certainty?: number }>;
}

function flatten(tree: Tree): Flat {
  const flat: Flat = { facts: new Map(), conditions: new Map() };
  const visit = (node: Tree) => {
    if (node.fact) {
      const k = `${node.fact.subject?.value} ${node.fact.relationship?.type} ${node.fact.object?.value}`;
      flat.facts.set(k, { source: node.source, certainty: node.fact.certainty });
      for (const c of node.rule?.conditions ?? []) {
        const text = c.expression?.text ? `expression ${c.expression.text}` : `${c.subject} ${c.relationship} ${c.object}`;
        flat.conditions.set(`${k} ⇐ ${text}`, {
          impact: c.impact,
          salience: c.salience,
          wasMet: c.wasMet,
          certainty: c.certainty,
        });
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return flat;
}

function diffEvidence(a: Flat, b: Flat): string[] {
  const out: string[] = [];
  for (const [k, va] of a.facts) {
    const vb = b.facts.get(k);
    if (!vb) out.push(`- － fact only in A: ${k} (${va.source}, ${va.certainty}%)`);
    else if (va.certainty !== vb.certainty) out.push(`- ~ ${k}: ${va.certainty}% → ${vb.certainty}% (${vb.source})`);
    else if (va.source !== vb.source) out.push(`- ~ ${k}: source ${va.source} → ${vb.source}`);
  }
  for (const [k, vb] of b.facts) {
    if (!a.facts.has(k)) out.push(`- ＋ fact only in B: ${k} (${vb.source}, ${vb.certainty}%)`);
  }
  for (const [k, ca] of a.conditions) {
    const cb = b.conditions.get(k);
    if (!cb) {
      out.push(`- － condition removed in B: ${k}`);
      continue;
    }
    const changes: string[] = [];
    if (ca.wasMet !== cb.wasMet) changes.push(`met ${ca.wasMet ?? "?"} → ${cb.wasMet ?? "?"}`);
    if (ca.impact !== cb.impact) changes.push(`impact ${ca.impact ?? "–"} → ${cb.impact ?? "–"}`);
    if (ca.salience !== cb.salience) changes.push(`salience ${ca.salience ?? "–"} → ${cb.salience ?? "–"}`);
    if (ca.certainty !== cb.certainty) changes.push(`certainty ${ca.certainty ?? "–"} → ${cb.certainty ?? "–"}`);
    if (changes.length) out.push(`- ~ condition ${k}: ${changes.join(", ")}`);
  }
  for (const k of b.conditions.keys()) {
    if (!a.conditions.has(k)) out.push(`- ＋ condition added in B: ${k}`);
  }
  return out;
}
