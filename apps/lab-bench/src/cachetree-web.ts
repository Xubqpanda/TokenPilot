import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type RuntimeEvent = { type?: string; source?: string; payload?: Record<string, unknown> };
type ModuleStep = { module?: string; stage?: string; timestamp?: string };

type EventTraceRow = {
  at?: string;
  logicalSessionId?: string;
  physicalSessionId?: string;
  provider?: string;
  model?: string;
  apiFamily?: string;
  usage?: Record<string, unknown>;
  eventTypes?: string[];
  finalContextEvents?: RuntimeEvent[];
  resultEvents?: RuntimeEvent[];
  contextDetail?: {
    moduleSteps?: ModuleStep[];
  };
};

type TurnView = {
  at: string;
  logicalSessionId: string;
  physicalSessionId: string;
  provider: string;
  model: string;
  apiFamily: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  netTokens: number | null;
  usageSource: "provider" | "fallback_zero" | "unknown";
  decisionEvents: string[];
  dataEvents: string[];
  executionEvents: string[];
  orchestrationSignals: string[];
  modulesByLayer: Record<string, string[]>;
  compactionRecommended: boolean;
  compactionApplied: boolean;
  compactionApplyPayload?: Record<string, unknown>;
};

type WindowSummary = {
  size: number;
  knownCount: number;
  inputSum: number;
  outputSum: number;
  cacheReadSum: number;
  netSumKnown: number;
  netAvgKnown: number | null;
};

const port = Number(process.env.ECOCLAW_VIS_PORT ?? "7777");
const host = process.env.ECOCLAW_VIS_HOST ?? "127.0.0.1";
const stateDir = resolve(process.env.ECOCLAW_STATE_DIR ?? "/tmp/ecoclaw-plugin-state");
const rootDir = join(stateDir, "ecoclaw");
const eventTracePath = process.env.ECOCLAW_EVENT_TRACE_PATH ?? join(rootDir, "event-trace.jsonl");
const roiPreTurnsDefault = Math.max(1, Number(process.env.ECOCLAW_ROI_PRE_TURNS ?? "3"));
const roiPostTurnsDefault = Math.max(1, Number(process.env.ECOCLAW_ROI_POST_TURNS ?? "3"));

const toNum = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

async function readJsonl(path: string): Promise<any[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function eventLayer(type: string): "data" | "decision" | "execution" | "orchestration" | "other" {
  if (type.startsWith("memory.")) return "data";
  if (type.startsWith("policy.") || type.startsWith("decision.")) return "decision";
  if (type.startsWith("cache.") || type.startsWith("summary.") || type.startsWith("compaction.")) return "execution";
  return "other";
}

function moduleLayer(name: string): "data" | "decision" | "execution" | "orchestration" | "other" {
  if (name.includes("memory") || name.includes("retrieval")) return "data";
  if (name.includes("policy") || name.includes("task-router") || name.includes("decision-ledger")) return "decision";
  if (name.includes("cache") || name.includes("summary") || name.includes("compression") || name.includes("compaction")) {
    return "execution";
  }
  if (name.includes("connector") || name.includes("openclaw")) return "orchestration";
  return "other";
}

function toTurnView(row: EventTraceRow): TurnView {
  const usage = row.usage ?? {};
  const inputRaw = toNum(usage.inputTokens);
  const outputRaw = toNum(usage.outputTokens);
  const cacheReadRaw = toNum(usage.cacheReadTokens ?? usage.cachedTokens);
  const providerRaw =
    usage && typeof usage === "object" && usage.providerRaw && typeof usage.providerRaw === "object"
      ? (usage.providerRaw as Record<string, unknown>)
      : undefined;
  const providerRawKeys = providerRaw ? Object.keys(providerRaw) : [];
  const hasExplicitUsageKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cachedTokens"].some((k) =>
    Object.prototype.hasOwnProperty.call(usage, k),
  );
  const allZeros =
    (inputRaw == null || inputRaw === 0) &&
    (outputRaw == null || outputRaw === 0) &&
    (cacheReadRaw == null || cacheReadRaw === 0);
  const usageSource: TurnView["usageSource"] =
    allZeros && hasExplicitUsageKeys && providerRawKeys.length === 0
      ? "fallback_zero"
      : inputRaw != null || outputRaw != null || cacheReadRaw != null
        ? "provider"
        : "unknown";
  const input = usageSource === "fallback_zero" ? null : inputRaw;
  const output = usageSource === "fallback_zero" ? null : outputRaw;
  const cacheRead = usageSource === "fallback_zero" ? null : cacheReadRaw;
  const netTokens = input == null || output == null || cacheRead == null ? null : input + output - cacheRead;

  const eventList: RuntimeEvent[] = [
    ...(Array.isArray(row.finalContextEvents) ? row.finalContextEvents : []),
    ...(Array.isArray(row.resultEvents) ? row.resultEvents : []),
  ];
  const eventTypes = eventList.map((e) => String(e.type ?? "")).filter(Boolean);
  const applyEvent = eventList.find((e) => String(e.type ?? "") === "compaction.apply.executed");

  const dataEvents = eventTypes.filter((t) => eventLayer(t) === "data");
  const decisionEvents = eventTypes.filter((t) => eventLayer(t) === "decision");
  const executionEvents = eventTypes.filter((t) => eventLayer(t) === "execution");

  const modulesByLayer: Record<string, string[]> = {
    data: [],
    decision: [],
    execution: [],
    orchestration: [],
    other: [],
  };
  const steps = Array.isArray(row.contextDetail?.moduleSteps) ? row.contextDetail?.moduleSteps : [];
  for (const s of steps) {
    const name = String(s?.module ?? "");
    if (!name) continue;
    const layer = moduleLayer(name);
    if (!modulesByLayer[layer].includes(name)) modulesByLayer[layer].push(name);
  }

  const orchestrationSignals: string[] = [];
  if ((row.logicalSessionId ?? "") !== (row.physicalSessionId ?? "")) {
    orchestrationSignals.push("logical/physical diverged (fork active)");
  }
  if (decisionEvents.includes("policy.fork.recommended")) {
    orchestrationSignals.push("policy.fork.recommended");
  }
  if (executionEvents.includes("compaction.apply.executed")) {
    orchestrationSignals.push("compaction.apply.executed");
  }

  return {
    at: String(row.at ?? ""),
    logicalSessionId: String(row.logicalSessionId ?? "unknown"),
    physicalSessionId: String(row.physicalSessionId ?? "unknown"),
    provider: String(row.provider ?? "-"),
    model: String(row.model ?? "-"),
    apiFamily: String(row.apiFamily ?? "other"),
    input,
    output,
    cacheRead,
    netTokens,
    usageSource,
    decisionEvents,
    dataEvents,
    executionEvents,
    orchestrationSignals,
    modulesByLayer,
    compactionRecommended: executionEvents.includes("compaction.trigger.recommended"),
    compactionApplied: executionEvents.includes("compaction.apply.executed"),
    compactionApplyPayload: (applyEvent?.payload as Record<string, unknown> | undefined) ?? undefined,
  };
}

function summarizeWindow(turns: TurnView[]): WindowSummary {
  let inputSum = 0;
  let outputSum = 0;
  let cacheReadSum = 0;
  let netSumKnown = 0;
  let knownCount = 0;

  for (const t of turns) {
    if (t.input != null) inputSum += t.input;
    if (t.output != null) outputSum += t.output;
    if (t.cacheRead != null) cacheReadSum += t.cacheRead;
    if (t.netTokens != null) {
      netSumKnown += t.netTokens;
      knownCount += 1;
    }
  }

  return {
    size: turns.length,
    knownCount,
    inputSum,
    outputSum,
    cacheReadSum,
    netSumKnown,
    netAvgKnown: knownCount > 0 ? netSumKnown / knownCount : null,
  };
}

function toIntInRange(value: string | null, fallback: number, min = 1, max = 20): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function buildDashboard(params?: { roiPreTurns?: number; roiPostTurns?: number }) {
  const roiPreTurns = Math.max(1, params?.roiPreTurns ?? roiPreTurnsDefault);
  const roiPostTurns = Math.max(1, params?.roiPostTurns ?? roiPostTurnsDefault);
  const rows = (await readJsonl(eventTracePath)) as EventTraceRow[];
  const turns = rows
    .map(toTurnView)
    .sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""));
  const compactionRoiRows: Array<Record<string, unknown>> = [];

  let inputSum = 0;
  let outputSum = 0;
  let cacheReadSum = 0;
  let netKnownSum = 0;
  let netKnownCount = 0;
  let compactionRecommendedCount = 0;
  let compactionAppliedCount = 0;
  const byApiFamily: Record<string, number> = {};

  for (const t of turns) {
    byApiFamily[t.apiFamily] = (byApiFamily[t.apiFamily] ?? 0) + 1;
    if (t.compactionRecommended) compactionRecommendedCount += 1;
    if (t.compactionApplied) compactionAppliedCount += 1;
    if (t.input != null) inputSum += t.input;
    if (t.output != null) outputSum += t.output;
    if (t.cacheRead != null) cacheReadSum += t.cacheRead;
    if (t.netTokens != null) {
      netKnownSum += t.netTokens;
      netKnownCount += 1;
    }
  }
  const byLogical: Record<string, TurnView[]> = {};
  for (const t of turns) {
    const key = t.logicalSessionId || "unknown";
    if (!byLogical[key]) byLogical[key] = [];
    byLogical[key].push(t);
  }
  for (const logicalSessionId of Object.keys(byLogical)) {
    const list = byLogical[logicalSessionId].sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""));
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t.compactionApplied) continue;
      const pre = summarizeWindow(list.slice(Math.max(0, i - roiPreTurns), i));
      const post = summarizeWindow(list.slice(i + 1, i + 1 + roiPostTurns));
      const deltaNetAvgKnown =
        pre.netAvgKnown == null || post.netAvgKnown == null ? null : post.netAvgKnown - pre.netAvgKnown;
      compactionRoiRows.push({
        at: t.at,
        logicalSessionId,
        fromPhysicalSessionId: String(t.compactionApplyPayload?.fromPhysicalSessionId ?? t.physicalSessionId ?? "-"),
        toPhysicalSessionId: String(t.compactionApplyPayload?.toPhysicalSessionId ?? "-"),
        summaryChars: toNum(t.compactionApplyPayload?.summaryChars) ?? null,
        pre,
        post,
        deltaNetAvgKnown,
      });
    }
  }
  compactionRoiRows.sort((a, b) => Date.parse(String(b.at ?? "")) - Date.parse(String(a.at ?? "")));

  return {
    meta: {
      rootDir,
      eventTracePath,
      turnCount: turns.length,
      inputSum,
      outputSum,
      cacheReadSum,
      netKnownSum,
      netKnownCount,
      compactionRecommendedCount,
      compactionAppliedCount,
      byApiFamily,
      updatedAt: new Date().toISOString(),
      roiWindow: {
        preTurns: roiPreTurns,
        postTurns: roiPostTurns,
      },
    },
    turns: turns.slice(-200).reverse(),
    compactionRoi: compactionRoiRows.slice(0, 60),
  };
}

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EcoClaw Runtime Decision Dashboard</title>
  <style>
    :root {
      --bg:#f4f7f9;
      --panel:#ffffff;
      --ink:#1d2a33;
      --muted:#5e6d78;
      --line:#dbe2e8;
      --accent:#1d6fa5;
      --good:#2d8d54;
      --warn:#b26a00;
    }
    * { box-sizing:border-box; }
    body { margin:0; font-family:"IBM Plex Sans","Noto Sans",sans-serif; background:var(--bg); color:var(--ink); }
    .wrap { max-width:1400px; margin:16px auto; padding:0 12px; }
    .row { display:grid; grid-template-columns:repeat(4,minmax(180px,1fr)); gap:10px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:10px; }
    .big { font-size:22px; font-weight:700; }
    .muted { color:var(--muted); font-size:12px; }
    h1 { margin:0 0 6px; font-size:28px; }
    .toolbar { display:flex; gap:8px; align-items:center; margin:10px 0; }
    button { border:1px solid var(--line); border-radius:8px; background:#fff; padding:6px 10px; cursor:pointer; }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th, td { text-align:left; border-bottom:1px solid #edf2f5; padding:6px 4px; vertical-align:top; }
    th { color:#44525d; }
    .chips { display:flex; gap:6px; flex-wrap:wrap; }
    .chip { background:#eef3f7; border:1px solid #d8e0e7; border-radius:999px; padding:2px 8px; font-size:11px; }
    .chip.good { background:#e8f6ed; border-color:#bfe6cb; color:var(--good); }
    .chip.warn { background:#fff3e3; border-color:#f0d0a8; color:var(--warn); }
    .mono { font-family:"JetBrains Mono","Fira Code",monospace; }
    @media (max-width: 1100px) { .row { grid-template-columns:repeat(2,minmax(160px,1fr)); } }
    @media (max-width: 680px) { .row { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>EcoClaw Runtime Decision Dashboard</h1>
    <div class="muted">Focus: cost-saving decisions across Data / Decision / Execution / Orchestration layers.</div>

    <div class="toolbar">
      <button id="refreshBtn">Refresh</button>
      <label class="muted">ROI pre
        <input id="preTurns" type="number" min="1" max="20" step="1" style="width:62px; margin-left:4px;" />
      </label>
      <label class="muted">post
        <input id="postTurns" type="number" min="1" max="20" step="1" style="width:62px; margin-left:4px;" />
      </label>
      <span class="muted" id="updatedAt">-</span>
    </div>

    <div class="row" id="kpis"></div>

    <div class="card" style="margin-top:10px;">
      <div style="font-weight:700; margin-bottom:8px;">Compaction ROI (pre3 vs post3 turns)</div>
      <div style="overflow:auto;">
        <table id="roiTable"></table>
      </div>
    </div>

    <div class="card" style="margin-top:10px;">
      <div style="font-weight:700; margin-bottom:8px;">Recent Turns (latest 200)</div>
      <div style="overflow:auto;">
        <table id="turnTable"></table>
      </div>
    </div>
  </div>

  <script>
    function fmt(n) { return n == null ? '-' : Number(n).toLocaleString(); }
    function ts(s) { try { return new Date(s).toLocaleString(); } catch { return String(s || '-'); } }

    function chips(list, kind) {
      if (!Array.isArray(list) || !list.length) return '<span class="muted">-</span>';
      return '<div class="chips">' + list.map(function(x){
        return '<span class="chip ' + (kind || '') + '">' + String(x) + '</span>';
      }).join('') + '</div>';
    }

    async function load() {
      var preInput = document.getElementById('preTurns');
      var postInput = document.getElementById('postTurns');
      var pre = preInput && preInput.value ? Number(preInput.value) : null;
      var post = postInput && postInput.value ? Number(postInput.value) : null;
      var qs = new URLSearchParams();
      if (pre != null && Number.isFinite(pre)) qs.set('pre', String(pre));
      if (post != null && Number.isFinite(post)) qs.set('post', String(post));
      var res = await fetch('/api/runtime' + (qs.toString() ? ('?' + qs.toString()) : ''));
      var data = await res.json();
      var meta = data.meta || {};
      var turns = Array.isArray(data.turns) ? data.turns : [];
      var compactionRoi = Array.isArray(data.compactionRoi) ? data.compactionRoi : [];

      document.getElementById('updatedAt').textContent = 'updated: ' + ts(meta.updatedAt);
      if (preInput && !preInput.value) preInput.value = String((meta.roiWindow || {}).preTurns || 3);
      if (postInput && !postInput.value) postInput.value = String((meta.roiWindow || {}).postTurns || 3);

      var byApi = Object.entries(meta.byApiFamily || {}).map(function(entry){
        return entry[0] + ': ' + entry[1];
      }).join(' | ') || '-';

      var kpiHtml = [
        ['Turns', meta.turnCount],
        ['Input Tokens', fmt(meta.inputSum)],
        ['Output Tokens', fmt(meta.outputSum)],
        ['Cache Read Tokens', fmt(meta.cacheReadSum)],
        ['Net Known Tokens (in+out-cacheRead)', fmt(meta.netKnownSum)],
        ['Compaction Recommended', meta.compactionRecommendedCount],
        ['Compaction Applied', meta.compactionAppliedCount],
        ['API Family Mix', byApi],
        ['Trace Path', '<span class="mono">' + String(meta.eventTracePath || '-') + '</span>'],
      ].map(function(item){
        return '<div class="card"><div class="muted">' + item[0] + '</div><div class="big">' + item[1] + '</div></div>';
      }).join('');
      document.getElementById('kpis').innerHTML = kpiHtml;

      var roiRows = ['<thead><tr>' +
        '<th>Time</th><th>Logical</th><th>From -> To</th><th>Summary</th>' +
        '<th>Pre Window</th><th>Post Window</th><th>Delta(NetAvg)</th>' +
      '</tr></thead><tbody>'];
      for (var r = 0; r < compactionRoi.length; r++) {
        var x = compactionRoi[r] || {};
        var pre = x.pre || {};
        var post = x.post || {};
        roiRows.push('<tr>' +
          '<td>' + ts(x.at) + '</td>' +
          '<td><span class="mono">' + String(x.logicalSessionId || '-') + '</span></td>' +
          '<td><span class="mono">' + String(x.fromPhysicalSessionId || '-') + ' → ' + String(x.toPhysicalSessionId || '-') + '</span></td>' +
          '<td>' + fmt(x.summaryChars) + '</td>' +
          '<td class="mono">n=' + fmt(pre.size) + ', known=' + fmt(pre.knownCount) + ', netAvg=' + fmt(pre.netAvgKnown) + '</td>' +
          '<td class="mono">n=' + fmt(post.size) + ', known=' + fmt(post.knownCount) + ', netAvg=' + fmt(post.netAvgKnown) + '</td>' +
          '<td class="mono">' + fmt(x.deltaNetAvgKnown) + '</td>' +
        '</tr>');
      }
      roiRows.push('</tbody>');
      document.getElementById('roiTable').innerHTML = roiRows.join('');

      var rows = ['<thead><tr>' +
        '<th>Time</th><th>Session</th><th>Model</th><th>Usage</th>' +
        '<th>Data Layer</th><th>Decision Layer</th><th>Execution Layer</th><th>Orchestration</th>' +
      '</tr></thead><tbody>'];

      for (var i = 0; i < turns.length; i++) {
        var t = turns[i];
        var usage = 'in/out/read/net = ' + [fmt(t.input), fmt(t.output), fmt(t.cacheRead), fmt(t.netTokens)].join(' / ');
        var orchestration = (Array.isArray(t.orchestrationSignals) && t.orchestrationSignals.length)
          ? chips(t.orchestrationSignals, 'warn')
          : '<span class="muted">-</span>';
        if (t.compactionRecommended) {
          orchestration += chips(['compaction.recommended'], 'good');
        }

        rows.push('<tr>' +
          '<td>' + ts(t.at) + '</td>' +
          '<td><div class="mono">' + String(t.logicalSessionId) + '</div></td>' +
          '<td><div>' + String(t.provider) + '/' + String(t.model) + '</div><div class="muted">' + String(t.apiFamily) + '</div></td>' +
          '<td><div class="mono">' + usage + '</div><div>' + (t.usageSource === 'fallback_zero' ? '<span class="chip warn">usage: unknown(fallback-zero)</span>' : (t.usageSource === 'provider' ? '<span class="chip good">usage: provider</span>' : '<span class="chip">usage: unknown</span>')) + '</div></td>' +
          '<td>' + chips(t.dataEvents) + chips((t.modulesByLayer || {}).data) + '</td>' +
          '<td>' + chips(t.decisionEvents) + chips((t.modulesByLayer || {}).decision) + '</td>' +
          '<td>' + chips(t.executionEvents) + chips((t.modulesByLayer || {}).execution) + '</td>' +
          '<td>' + orchestration + '</td>' +
        '</tr>');
      }
      rows.push('</tbody>');
      document.getElementById('turnTable').innerHTML = rows.join('');
    }

    document.getElementById('refreshBtn').onclick = load;
    load().catch(function(err){ console.error(err); alert('Failed to load runtime dashboard'); });
  </script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);

  if (url.pathname === "/api/runtime") {
    const roiPreTurns = toIntInRange(url.searchParams.get("pre"), roiPreTurnsDefault);
    const roiPostTurns = toIntInRange(url.searchParams.get("post"), roiPostTurnsDefault);
    const dashboard = await buildDashboard({ roiPreTurns, roiPostTurns });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(dashboard));
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(port, host, () => {
  console.log(`EcoClaw runtime dashboard: http://${host}:${port}`);
  console.log(`stateDir=${stateDir}`);
  console.log(`eventTracePath=${eventTracePath}`);
});
