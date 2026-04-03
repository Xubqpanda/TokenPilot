import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.ECOCLAW_LAB_PORT ?? 7777);
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const dashboardDataUrl = new URL("./dashboard-data.ts", import.meta.url).href;
const editorTransformsUrl = new URL("./editor-transforms.ts", import.meta.url).href;

type DashboardDataModule = typeof import("./dashboard-data.js");
type EditorTransformsModule = typeof import("./editor-transforms.js");

let dashboardDataPromise: Promise<DashboardDataModule> | null = null;
let editorTransformsPromise: Promise<EditorTransformsModule> | null = null;

function loadDashboardData(): Promise<DashboardDataModule> {
  dashboardDataPromise ??= import(dashboardDataUrl) as Promise<DashboardDataModule>;
  return dashboardDataPromise;
}

function loadEditorTransforms(): Promise<EditorTransformsModule> {
  editorTransformsPromise ??= import(editorTransformsUrl) as Promise<EditorTransformsModule>;
  return editorTransformsPromise;
}

function send(res: ServerResponse, status: number, body: string, contentType: string) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  send(res, status, JSON.stringify(payload, null, 2), "application/json; charset=utf-8");
}

function notFound(res: ServerResponse) {
  send(res, 404, "Not found", "text/plain; charset=utf-8");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${port}`}`);

    if (req.method === "GET" && url.pathname === "/") {
      send(res, 200, await readFile(join(publicDir, "index.html"), "utf8"), "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/styles.css") {
      send(res, 200, await readFile(join(publicDir, "styles.css"), "utf8"), "text/css; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
      send(res, 200, await readFile(join(publicDir, "app.js"), "utf8"), "application/javascript; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/overview") {
      const { loadOverview } = await loadDashboardData();
      sendJson(res, 200, await loadOverview());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/session-turns") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }
      const { loadSessionTurns } = await loadDashboardData();
      sendJson(res, 200, await loadSessionTurns(sessionId));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/turn") {
      const traceId = url.searchParams.get("traceId") ?? "";
      if (!traceId) {
        sendJson(res, 400, { error: "traceId is required" });
        return;
      }
      const { loadTurnDetail } = await loadDashboardData();
      const detail = await loadTurnDetail(traceId);
      if (!detail) {
        sendJson(res, 404, { error: "turn not found" });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/branch-action") {
      const body = await readJsonBody(req);
      const traceId = String(body.traceId ?? "").trim();
      const action = String(body.action ?? "").trim();
      if (!traceId) {
        sendJson(res, 400, { error: "traceId is required" });
        return;
      }
      if (action !== "fork" && action !== "revert") {
        sendJson(res, 400, { error: "action must be fork or revert" });
        return;
      }
      const { createManualBranchAction } = await loadDashboardData();
      sendJson(res, 200, await createManualBranchAction(traceId, action));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/editor/transform") {
      const body = await readJsonBody(req);
      const mode = String(body.mode ?? "").trim();
      const blocks = body.blocks;
      if (!Array.isArray(blocks) || blocks.length === 0) {
        sendJson(res, 400, { error: "blocks must be a non-empty array" });
        return;
      }
      if (mode !== "summary" && mode !== "reduction") {
        sendJson(res, 400, { error: "mode must be summary or reduction" });
        return;
      }
      const { buildReductionPreview, buildSummaryPreview } = await loadEditorTransforms();
      sendJson(res, 200, mode === "summary" ? buildSummaryPreview(blocks) : buildReductionPreview(blocks));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/editor/apply-draft") {
      const body = await readJsonBody(req);
      const traceId = String(body.traceId ?? "").trim();
      const draftBlocks = body.draftBlocks;
      if (!traceId) {
        sendJson(res, 400, { error: "traceId is required" });
        return;
      }
      if (!Array.isArray(draftBlocks) || draftBlocks.length === 0) {
        sendJson(res, 400, { error: "draftBlocks must be a non-empty array" });
        return;
      }
      const { applyDraftPlan } = await loadDashboardData();
      sendJson(res, 200, await applyDraftPlan(traceId, draftBlocks as never[]));
      return;
    }

    if (req.method !== "GET" && req.method !== "POST") {
      send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
      return;
    }

    notFound(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[ecoclaw/lab-bench] dashboard listening on http://127.0.0.1:${port}`);
});
