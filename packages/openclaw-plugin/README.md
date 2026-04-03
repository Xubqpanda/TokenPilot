# EcoClaw OpenClaw Plugin

This plugin adds a runtime optimization layer to OpenClaw and registers an
explicit provider namespace:

- `ecoclaw/<model>` (example: `ecoclaw/gpt-5.4`)

It includes:

- Embedded responses proxy
- Stable-prefix cache reuse for OpenAI Responses-compatible providers
- Cache/summary/compaction decision modules
- Session topology + `/ecoclaw` command controls
- JSONL event tracing for analysis

## 1) Release Install And Enable

```bash
cd packages/openclaw-plugin
npm run install:release
```

Or in two explicit steps:

```bash
cd packages/openclaw-plugin
npm run pack:release
openclaw plugins install ./ecoclaw-*.tgz
openclaw gateway restart
```

This is the recommended end-user path. It installs EcoClaw into:

```text
~/.openclaw/extensions/ecoclaw
```

Recommended trusted plugin allowlist:

```bash
openclaw config set plugins.allow "[\"ecoclaw\"]"
openclaw config set plugins.entries.ecoclaw.enabled true
openclaw gateway restart
```

## 2) Development-Mode Install

If you are iterating on plugin source directly, use a load-path install instead:

```bash
openclaw config set plugins.load.paths "[\"/abs/path/to/EcoClaw/packages/openclaw-plugin\"]"
openclaw config set plugins.allow "[\"ecoclaw\"]"
openclaw config set plugins.entries.ecoclaw.enabled true
openclaw gateway restart
```

Do not keep release install and dev load-path active at the same time. They use
the same plugin id (`ecoclaw`) and OpenClaw will report duplicate plugin
sources.

## 3) Supported Plugin Config

```bash
openclaw config set plugins.entries.ecoclaw.config.stateDir "$HOME/.openclaw/ecoclaw-plugin-state"
openclaw config set plugins.entries.ecoclaw.config.proxyAutostart true
openclaw config set plugins.entries.ecoclaw.config.proxyPort 17667
openclaw gateway restart
```

Optional debug:

```bash
openclaw config set plugins.entries.ecoclaw.config.logLevel debug
openclaw config set plugins.entries.ecoclaw.config.debugTapProviderTraffic true
openclaw config set plugins.entries.ecoclaw.config.debugTapPath "$HOME/.openclaw/ecoclaw-plugin-state/ecoclaw/provider-traffic.jsonl"
openclaw gateway restart
```

Optional semantic reduction:

```bash
openclaw config set plugins.entries.ecoclaw.config.semanticReduction.enabled true
openclaw config set plugins.entries.ecoclaw.config.semanticReduction.pythonBin "python"
openclaw config set plugins.entries.ecoclaw.config.semanticReduction.llmlinguaModelPath "/abs/path/to/llmlingua-2-bert-base-multilingual-cased-meetingbank"
openclaw config set plugins.entries.ecoclaw.config.semanticReduction.embedding.provider "local"
openclaw config set plugins.entries.ecoclaw.config.semanticReduction.embedding.modelPath "/abs/path/to/all-MiniLM-L6-v2"
openclaw gateway restart
```

Optional compaction + summary controls:

```bash
openclaw config set plugins.entries.ecoclaw.config.compaction.enabled true
openclaw config set plugins.entries.ecoclaw.config.compaction.autoForkOnPolicy true
openclaw config set plugins.entries.ecoclaw.config.compaction.summaryGenerationMode "heuristic"
openclaw config set plugins.entries.ecoclaw.config.compaction.compactionCooldownTurns 6
openclaw gateway restart
```

If you want custom prompts for summary / resume:

```bash
openclaw config set plugins.entries.ecoclaw.config.compaction.summaryPromptPath "/abs/path/to/default-summary.md"
openclaw config set plugins.entries.ecoclaw.config.compaction.resumePrefixPromptPath "/abs/path/to/default-resume-prefix.md"
openclaw gateway restart
```

If you prefer remote embeddings instead of a local embedding model:

```bash
openclaw config set plugins.entries.ecoclaw.config.semanticReduction.embedding.provider "api"
openclaw config set plugins.entries.ecoclaw.config.semanticReduction.embedding.apiBaseUrl "https://your-openai-compatible-base/v1"
openclaw config set plugins.entries.ecoclaw.config.semanticReduction.embedding.apiKey "<secret>"
openclaw config set plugins.entries.ecoclaw.config.semanticReduction.embedding.apiModel "text-embedding-3-small"
openclaw gateway restart
```

Valid config keys are only:

- `enabled`
- `logLevel`
- `proxyBaseUrl`
- `proxyApiKey`
- `stateDir`
- `debugTapProviderTraffic`
- `debugTapPath`
- `proxyAutostart`
- `proxyPort`
- `compaction`
- `semanticReduction`

Recommended `compaction` defaults:

- `enabled=true`
- `autoForkOnPolicy=true`
- `summaryGenerationMode="heuristic"`
- `summaryFallbackToHeuristic=true`
- `summaryMaxOutputTokens=1200`
- `includeAssistantReply=true`
- `compactionCooldownTurns=6`

## 4) Model Selection

In OpenClaw, use explicit EcoClaw provider models:

```text
ecoclaw/gpt-5.4
```

The plugin auto-starts an embedded proxy and syncs explicit model aliases into
`~/.openclaw/openclaw.json` when possible.

## 5) How Cache Reuse Works

For the default Responses path, EcoClaw does not rely on `previous_response_id`
to force cross-task reuse. The stable hit comes from keeping the cacheable
prefix byte-identical across requests:

- Normalize dynamic timestamp prefixes like `[Fri 2026-03-27 14:08 GMT+8]` to `[<TS>]`, then append the real timestamp back at the tail as metadata
- Compute one stable `prompt_cache_key` from normalized model + instructions + developer prompt + tool fingerprint
- Force `prompt_cache_retention = "24h"` on outbound `/responses` calls

Once one request warms that normalized prefix, later same-session turns and
forked first turns land in the same upstream cache partition and can reuse it.

## 6) Commands

Use slash commands in TUI:

```text
/ecoclaw help              # show command usage and examples
/ecoclaw status            # current binding (sessionKey/task/logical/seq)
/ecoclaw cache list        # list known task-cache workspaces
/ecoclaw cache new <id>    # create/switch current task-cache
/ecoclaw cache delete <id> # delete task-cache and purge local state
/ecoclaw session new       # create next logical session in current task-cache
```

You can also type inline form (`ecoclaw status`), but slash form is preferred.

## 7) Runtime Files

Default state directory:

```text
$HOME/.openclaw/ecoclaw-plugin-state/ecoclaw/
```

Important files:

- `event-trace.jsonl`: per-turn pipeline events
- `provider-traffic.jsonl`: provider tap debug log (if enabled)
- `response-root-state.json`: root-link metadata cache
- `sessions/<logical>/turns.jsonl`: logical session turn history

## 8) Runtime Inspection

When you test EcoClaw inside real OpenClaw, the fastest way to understand what
it decided is to inspect `event-trace.jsonl`.

Key places to look:

- `finalContext.metadata.policy`: full online policy snapshot for that turn
- `finalContext.metadata.policy.roi`: explicit ROI estimates for summary, compaction, and reduction
- `finalContext.metadata.policy.decisions`: which execution paths were requested
- `finalContext.metadata.reduction.beforeCallSummary`: pre-call reduction summary
- `finalContext.metadata.reduction.afterCallSummary`: post-call reduction summary
- `finalContext.metadata.summary`: latest summary generation artifact
- `finalContext.metadata.compaction`: latest compaction plan/apply artifact

Important ROI fields:

- `estimatedSavedTokens`: expected tokens saved if this action is taken
- `estimatedCostTokens`: expected extra tokens spent to execute the action
- `netTokens`: `saved - cost`
- `recommended`: current heuristic recommendation
- `confidence`: `low | medium | high`
- `notes`: short explanation for the estimate

You can also watch provider-level payload behavior with:

```bash
tail -f "$HOME/.openclaw/ecoclaw-plugin-state/ecoclaw/provider-traffic.jsonl"
```

This is useful when you want to confirm:

- stabilized prefixes are actually leaving through the proxy
- `prompt_cache_retention="24h"` is present on outbound Responses calls
- upstream usage fields are present or missing on a specific turn

## 9) Acceptance Test

Unified entry:

```bash
cd packages/openclaw-plugin
npm run acceptance:e2e
```

Mode variants:

```bash
bash ./scripts/e2e.sh cache
bash ./scripts/e2e.sh cache-multi
bash ./scripts/e2e.sh cache-fork
bash ./scripts/e2e.sh semantic
bash ./scripts/e2e.sh summary
bash ./scripts/e2e.sh compaction
bash ./scripts/e2e.sh report
```

The unified entry is intentionally dispatcher-style, so later we can add more modes
without changing the main workflow: each new E2E scenario only needs a new mode
mapping or a new underlying script.

Build a unified acceptance report from the latest artifacts:

```bash
cd packages/openclaw-plugin
npm run acceptance:report
```

This writes:

- `packages/openclaw-plugin/.tmp/acceptance-report/report.json`
- `packages/openclaw-plugin/.tmp/acceptance-report/report.md`

Run the built-in cache acceptance harness:

```bash
cd packages/openclaw-plugin
npm run acceptance:cache
```

Useful variants:

```bash
TARGET_CLEAN_RUNS=1 bash ./scripts/cache_acceptance.sh multi
TARGET_CLEAN_RUNS=1 bash ./scripts/cache_acceptance.sh fork
```

The harness:

- seeds a minimal Responses session scaffold
- verifies same-session bridge -> task1 -> task2 -> task3 cache reuse
- verifies bridge -> fork_A / fork_B / fork_C first-turn reuse
- retries noisy runs and requires cache-read thresholds before reporting success

Outputs are written under `packages/openclaw-plugin/.tmp/cache-acceptance/`.

Run the semantic reduction end-to-end harness:

```bash
cd packages/openclaw-plugin
npm run acceptance:semantic
```

Useful overrides:

```bash
SEMANTIC_PYTHON_BIN="/abs/path/to/python" \
SEMANTIC_LLM_MODEL_PATH="/abs/path/to/llmlingua-2-bert-base-multilingual-cased-meetingbank" \
EMBEDDING_PROVIDER=local \
EMBEDDING_MODEL_PATH="/abs/path/to/all-MiniLM-L6-v2" \
bash ./scripts/semantic_e2e.sh
```

For API embeddings:

```bash
EMBEDDING_PROVIDER=api \
EMBEDDING_API_BASE_URL="https://your-openai-compatible-base/v1" \
EMBEDDING_API_KEY="<secret>" \
EMBEDDING_API_MODEL="text-embedding-3-small" \
bash ./scripts/semantic_e2e.sh
```

The semantic harness:

- rebuilds the plugin dist bundle
- writes a temporary `semanticReduction` plugin config
- restarts OpenClaw gateway
- sends a real agent turn through the plugin path
- reads the new EcoClaw trace entry and verifies `policy -> reduction -> semantic_llmlingua2`
- restores the original OpenClaw config unless `KEEP_CONFIG=1`

Run the compaction end-to-end harness:

```bash
cd packages/openclaw-plugin
npm run acceptance:compaction
```

Useful overrides:

```bash
COMPACTION_TRIGGER_TURN_COUNT=1 \
SUMMARY_GENERATION_MODE=heuristic \
bash ./scripts/compaction_e2e.sh
```

The compaction harness:

- rebuilds the plugin dist bundle
- writes a temporary `compaction` plugin config
- restarts OpenClaw gateway
- sends three real turns through the same OpenClaw session
- verifies turn 2 emits `policy.compaction.requested -> compaction.plan.generated -> compaction.apply.executed`
- verifies `summary.generated` only when summary policy was independently requested for that same turn
- verifies turn 3 is routed onto the newly forked shadow physical session
- restores the original OpenClaw config unless `KEEP_CONFIG=1`

Run the summary end-to-end harness:

```bash
cd packages/openclaw-plugin
npm run acceptance:summary
```

Useful overrides:

```bash
SUMMARY_GENERATION_MODE=heuristic \
SUMMARY_TRIGGER_STABLE_CHARS=1 \
bash ./scripts/summary_e2e.sh
```

The summary harness:

- rebuilds the plugin dist bundle
- writes a temporary `compaction` plugin config with compaction apply disabled
- restarts OpenClaw gateway
- sends one real agent turn through the plugin path
- verifies `policy.summary.requested -> summary.generated -> context.state.updated`
- verifies this run does not emit compaction plan/apply events
- restores the original OpenClaw config unless `KEEP_CONFIG=1`

## 10) Dashboard

```bash
cd apps/lab-bench
corepack pnpm --filter @ecoclaw/lab-bench dev
```

Open `http://127.0.0.1:7777` to inspect runtime decisions and compaction ROI.
