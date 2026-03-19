import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { URL } from "node:url";

type EventTraceRow = {
  at?: string;
  logicalSessionId?: string;
  physicalSessionId?: string;
  eventTypes?: string[];
  resultEvents?: Array<{
    type?: string;
    payload?: Record<string, unknown>;
  }>;
};

type SessionOverview = {
  sessionId: string;
  updatedAt?: string;
  provider?: string;
  model?: string;
  turnCount?: number;
  summaryUpdatedAt?: string;
  summaryPreview?: string;
};

const port = Number(process.env.ECOCLAW_VIS_PORT ?? "7777");
const stateDir = resolve(process.env.ECOCLAW_STATE_DIR ?? "/tmp/ecoclaw-plugin-state");
const rootDir = join(stateDir, "ecoclaw");
const sessionsDir = join(rootDir, "sessions");
const eventTracePath = process.env.ECOCLAW_EVENT_TRACE_PATH ?? join(rootDir, "event-trace.jsonl");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EcoClaw CacheTree Inspector</title>
  <style>
    :root {
      --bg: #f7f6f2;
      --panel: #fffdf7;
      --ink: #1f2a33;
      --muted: #67737d;
      --line: #d9d1bf;
      --accent: #b35c1e;
      --accent-soft: #f2dfcf;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Noto Sans", sans-serif;
      background: radial-gradient(circle at top right, #ece4d4 0%, var(--bg) 55%);
      color: var(--ink);
    }
    .wrap { max-width: 1200px; margin: 24px auto 40px; padding: 0 14px; }
    .title { margin: 0 0 4px; font-size: 28px; letter-spacing: 0.2px; }
    .sub { margin: 0 0 16px; color: var(--muted); }
    .grid { display: grid; gap: 14px; grid-template-columns: 1fr; }
    @media (min-width: 980px) { .grid { grid-template-columns: 1.1fr 1fr; } }
    .card {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 14px;
      padding: 12px 14px;
      box-shadow: 0 8px 20px rgba(41, 30, 9, 0.06);
    }
    .card h2 { margin: 0 0 10px; font-size: 16px; }
    .kv { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; border-bottom: 1px solid #efe7d5; padding: 7px 4px; vertical-align: top; }
    th { color: #4f5a63; font-weight: 600; }
    .pill {
      display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px;
      border: 1px solid #d2b99d; background: var(--accent-soft); color: #744018;
    }
    .tiny { font-size: 12px; color: var(--muted); }
    .mono { font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 12px; }
    .row-highlight { background: #fdf5ea; }
    .empty { color: var(--muted); font-size: 13px; padding: 10px 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 class="title">EcoClaw CacheTree Inspector</h1>
    <p class="sub">Live view over persisted state and event trace. Refreshes every 5s.</p>
    <div id="meta" class="card" style="margin-bottom:14px"></div>
    <div class="grid">
      <div class="card">
        <h2>Cache Event Timeline</h2>
        <div id="events"></div>
      </div>
      <div class="card">
        <h2>Persisted Sessions & Summaries</h2>
        <div id="sessions"></div>
      </div>
    </div>
  </div>
  <script>
    function esc(v) {
      return String(v ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function renderMeta(data) {
      const el = document.getElementById("meta");
      el.innerHTML = \`
        <h2 style="margin:0 0 8px">Runtime Sources</h2>
        <div class="kv mono">stateRoot: \${esc(data.paths.rootDir)}</div>
        <div class="kv mono">eventTrace: \${esc(data.paths.eventTracePath)}</div>
        <div class="tiny">event rows: <span class="pill">\${data.events.length}</span> &nbsp; sessions: <span class="pill">\${data.sessions.length}</span></div>
      \`;
    }

    function renderEvents(events) {
      const el = document.getElementById("events");
      if (!events.length) {
        el.innerHTML = '<div class="empty">No event-trace rows found yet.</div>';
        return;
      }
      const rows = events.slice().reverse().slice(0, 40).map((r, idx) => {
        const cacheRecord = (r.resultEvents || []).find((ev) => ev.type === "cache.after_call.recorded");
        const p = cacheRecord ? (cacheRecord.payload || {}) : {};
        const nodeId = p.nodeId || "-";
        const branch = p.branch || "-";
        const expiresAt = p.expiresAt || "-";
        const readTokens = p.readTokens || 0;
        return \`
          <tr class="\${idx === 0 ? "row-highlight" : ""}">
            <td class="mono">\${esc(r.at || "-")}</td>
            <td class="mono">\${esc(r.logicalSessionId || "-")}</td>
            <td class="mono">\${esc(r.physicalSessionId || "-")}</td>
            <td class="mono">\${esc(nodeId)}</td>
            <td>\${esc(branch)}</td>
            <td class="mono">\${esc(expiresAt)}</td>
            <td>\${esc(readTokens)}</td>
          </tr>
        \`;
      }).join("");

      el.innerHTML = \`
        <table>
          <thead>
            <tr>
              <th>at</th>
              <th>logicalSession</th>
              <th>physicalSession</th>
              <th>nodeId</th>
              <th>branch</th>
              <th>expiresAt</th>
              <th>cacheRead</th>
            </tr>
          </thead>
          <tbody>\${rows}</tbody>
        </table>
      \`;
    }

    function renderSessions(sessions) {
      const el = document.getElementById("sessions");
      if (!sessions.length) {
        el.innerHTML = '<div class="empty">No persisted sessions found in state store.</div>';
        return;
      }
      const rows = sessions
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .slice(0, 40)
        .map((s) => \`
          <tr>
            <td class="mono">\${esc(s.sessionId)}</td>
            <td>\${esc(s.provider || "-")}/\${esc(s.model || "-")}</td>
            <td>\${esc(s.turnCount ?? "-")}</td>
            <td class="mono">\${esc(s.updatedAt || "-")}</td>
            <td class="mono">\${esc(s.summaryUpdatedAt || "-")}</td>
            <td>\${esc(s.summaryPreview || "")}</td>
          </tr>
        \`)
        .join("");
      el.innerHTML = \`
        <table>
          <thead>
            <tr>
              <th>session</th>
              <th>provider/model</th>
              <th>turns</th>
              <th>updatedAt</th>
              <th>summaryAt</th>
              <th>summaryPreview</th>
            </tr>
          </thead>
          <tbody>\${rows}</tbody>
        </table>
      \`;
    }

    async function refresh() {
      const resp = await fetch("/api/state");
      const data = await resp.json();
      renderMeta(data);
      renderEvents(data.events);
      renderSessions(data.sessions);
    }

    refresh().catch((e) => console.error(e));
    setInterval(() => refresh().catch((e) => console.error(e)), 5000);
  </script>
</body>
</html>`;

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readEventTraceRows(): Promise<EventTraceRow[]> {
  try {
    const raw = await readFile(eventTracePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as EventTraceRow;
        } catch {
          return {} as EventTraceRow;
        }
      })
      .filter((row) => Object.keys(row).length > 0);
  } catch {
    return [];
  }
}

async function readSessions(): Promise<SessionOverview[]> {
  try {
    const children = await readdir(sessionsDir);
    const rows: SessionOverview[] = [];
    for (const child of children) {
      const sessionDir = join(sessionsDir, child);
      const s = await stat(sessionDir).catch(() => null);
      if (!s?.isDirectory()) continue;
      const meta = await readJsonFile<Record<string, unknown>>(join(sessionDir, "meta.json"));
      const summary = await readJsonFile<Record<string, unknown>>(join(sessionDir, "summary.json"));
      rows.push({
        sessionId: String(meta?.sessionId ?? child),
        updatedAt: typeof meta?.updatedAt === "string" ? meta.updatedAt : undefined,
        provider: typeof meta?.provider === "string" ? meta.provider : undefined,
        model: typeof meta?.model === "string" ? meta.model : undefined,
        turnCount: typeof meta?.turnCount === "number" ? meta.turnCount : undefined,
        summaryUpdatedAt: typeof summary?.updatedAt === "string" ? summary.updatedAt : undefined,
        summaryPreview:
          typeof summary?.summary === "string" ? String(summary.summary).replace(/\s+/g, " ").slice(0, 160) : undefined,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/state") {
    const [events, sessions] = await Promise.all([readEventTraceRows(), readSessions()]);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify(
        {
          paths: {
            stateDir,
            rootDir,
            sessionsDir,
            eventTracePath,
          },
          events,
          sessions,
        },
        null,
        2,
      ),
    );
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[ecoclaw-cachetree-web] listening on http://127.0.0.1:${port}`);
  console.log(`[ecoclaw-cachetree-web] stateDir=${stateDir}`);
  console.log(`[ecoclaw-cachetree-web] eventTrace=${eventTracePath}`);
});
