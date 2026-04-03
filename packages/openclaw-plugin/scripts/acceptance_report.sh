#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

OUT_DIR="${ECOCLAW_ACCEPTANCE_REPORT_OUT_DIR:-$PKG_DIR/.tmp/acceptance-report}"
CACHE_SUMMARY_JSON="${ECOCLAW_CACHE_SUMMARY_JSON:-$PKG_DIR/.tmp/cache-acceptance/summary.json}"
SEMANTIC_DIR="${ECOCLAW_SEMANTIC_OUT_DIR:-$PKG_DIR/.tmp/semantic-e2e}"
SUMMARY_DIR="${ECOCLAW_SUMMARY_OUT_DIR:-$PKG_DIR/.tmp/summary-e2e}"
COMPACTION_DIR="${ECOCLAW_COMPACTION_OUT_DIR:-$PKG_DIR/.tmp/compaction-e2e}"
RUN_ID="${ECOCLAW_ACCEPTANCE_REPORT_RUN_ID:-$(date +%s)}"

mkdir -p "$OUT_DIR"

REPORT_JSON="$OUT_DIR/report-${RUN_ID}.json"
REPORT_MD="$OUT_DIR/report-${RUN_ID}.md"
LATEST_JSON="$OUT_DIR/report.json"
LATEST_MD="$OUT_DIR/report.md"

node - "$CACHE_SUMMARY_JSON" "$SEMANTIC_DIR" "$SUMMARY_DIR" "$COMPACTION_DIR" "$REPORT_JSON" "$REPORT_MD" "$RUN_ID" <<'NODE'
const fs = require("fs");
const path = require("path");

const cacheSummaryJson = process.argv[2];
const semanticDir = process.argv[3];
const summaryDir = process.argv[4];
const compactionDir = process.argv[5];
const reportJson = process.argv[6];
const reportMd = process.argv[7];
const runId = process.argv[8];

const safeReadJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const latestMatchingJson = (dir) => {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => /^summary-.*\.json$/.test(name))
      .sort((a, b) => {
        const aTime = fs.statSync(path.join(dir, a)).mtimeMs;
        const bTime = fs.statSync(path.join(dir, b)).mtimeMs;
        return bTime - aTime;
      });
    return files.length > 0 ? path.join(dir, files[0]) : null;
  } catch {
    return null;
  }
};

const moduleEntries = [];

const pushModule = (name, file, data) => {
  if (!file || !data) {
    moduleEntries.push({
      module: name,
      status: "missing",
      file: file || null,
      validated: {},
      passed: 0,
      total: 0,
      details: {},
    });
    return;
  }
  const validated = data.validated || {};
  const requiredKeys = Array.isArray(data.requiredValidatedKeys) && data.requiredValidatedKeys.length > 0
    ? data.requiredValidatedKeys
    : Object.keys(validated);
  const total = requiredKeys.length;
  const passed = requiredKeys.filter((key) => validated[key] === true).length;
  moduleEntries.push({
    module: name,
    status: total > 0 && passed === total ? "passed" : "failed",
    file,
    validated,
    requiredValidatedKeys: requiredKeys,
    passed,
    total,
    details:
      name === "cache"
        ? {
            mode: data.mode,
            accepted: data.counts?.accepted ?? null,
            noisy: data.counts?.noisy ?? null,
            totalRuns: data.counts?.total ?? null,
          }
        : {
            sessionId: data.sessionId ?? null,
            traceAt: data.traceAt ?? null,
            apiFamily: data.apiFamily ?? null,
          },
  });
};

const cacheData = safeReadJson(cacheSummaryJson);
pushModule("cache", cacheSummaryJson, cacheData);

const semanticFile = latestMatchingJson(semanticDir);
pushModule("semantic", semanticFile, semanticFile ? safeReadJson(semanticFile) : null);

const summaryFile = latestMatchingJson(summaryDir);
pushModule("summary", summaryFile, summaryFile ? safeReadJson(summaryFile) : null);

const compactionFile = latestMatchingJson(compactionDir);
pushModule("compaction", compactionFile, compactionFile ? safeReadJson(compactionFile) : null);

const overall = {
  moduleCount: moduleEntries.length,
  passedCount: moduleEntries.filter((item) => item.status === "passed").length,
  failedCount: moduleEntries.filter((item) => item.status === "failed").length,
  missingCount: moduleEntries.filter((item) => item.status === "missing").length,
};

const report = {
  runId,
  generatedAt: new Date().toISOString(),
  overall,
  modules: moduleEntries,
};

const md = [
  "# EcoClaw Acceptance Report",
  "",
  `- runId: ${runId}`,
  `- generatedAt: ${report.generatedAt}`,
  `- passed: ${overall.passedCount}/${overall.moduleCount}`,
  `- failed: ${overall.failedCount}`,
  `- missing: ${overall.missingCount}`,
  "",
  "| module | status | checks | artifact | notes |",
  "| --- | --- | --- | --- | --- |",
  ...moduleEntries.map((item) => {
    const artifact = item.file ? `\`${item.file}\`` : "-";
    const checks = item.total > 0 ? `${item.passed}/${item.total}` : "-";
    const notes =
      item.module === "cache"
        ? `mode=${item.details.mode ?? "-"}, accepted=${item.details.accepted ?? "-"}, noisy=${item.details.noisy ?? "-"}`
        : `apiFamily=${item.details.apiFamily ?? "-"}, session=${item.details.sessionId ?? "-"}`;
    return `| ${item.module} | ${item.status} | ${checks} | ${artifact} | ${notes} |`;
  }),
  "",
].join("\n");

fs.writeFileSync(reportJson, JSON.stringify(report, null, 2));
fs.writeFileSync(reportMd, md);
console.log(JSON.stringify({ reportJson, reportMd, overall }, null, 2));
NODE

cp "$REPORT_JSON" "$LATEST_JSON"
cp "$REPORT_MD" "$LATEST_MD"

echo "[acceptance-report] json: $REPORT_JSON"
echo "[acceptance-report] markdown: $REPORT_MD"
echo "[acceptance-report] latest json: $LATEST_JSON"
echo "[acceptance-report] latest markdown: $LATEST_MD"
