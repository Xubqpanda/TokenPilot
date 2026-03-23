# EcoClaw OpenClaw Plugin

This plugin adds a runtime optimization layer to OpenClaw and registers an
explicit provider namespace:

- `ecoclaw/<model>` (example: `ecoclaw/gpt-5.4`)

It includes:

- Embedded responses proxy
- Response root-link cache reuse
- Cache/summary/compaction decision modules
- Session topology + `/ecoclaw` command controls
- JSONL event tracing for analysis

## 1) Install And Enable

```bash
cd packages/openclaw-plugin
npm run build
openclaw plugins install .
```

Recommended trusted plugin allowlist:

```bash
openclaw config set plugins.allow "[\"ecoclaw\"]"
openclaw config set plugins.entries.ecoclaw.enabled true
openclaw gateway restart
```

## 2) Required Runtime Settings

```bash
openclaw config set plugins.entries.ecoclaw.config.runtimeMode shadow
openclaw config set plugins.entries.ecoclaw.config.stateDir "/tmp/ecoclaw-plugin-state"
openclaw config set plugins.entries.ecoclaw.config.eventTracePath "/tmp/ecoclaw-plugin-state/ecoclaw/event-trace.jsonl"
openclaw gateway restart
```

Optional debug:

```bash
openclaw config set plugins.entries.ecoclaw.config.logLevel debug
openclaw config set plugins.entries.ecoclaw.config.debugTapProviderTraffic true
openclaw gateway restart
```

## 3) Model Selection

In OpenClaw, use explicit EcoClaw provider models:

```text
ecoclaw/gpt-5.4
```

The plugin auto-starts an embedded proxy and syncs explicit model aliases into
`~/.openclaw/openclaw.json` when possible.

## 4) Commands

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

## 5) Runtime Files

Default state directory:

```text
/tmp/ecoclaw-plugin-state/ecoclaw/
```

Important files:

- `event-trace.jsonl`: per-turn pipeline events
- `provider-traffic.jsonl`: provider tap debug log (if enabled)
- `response-root-state.json`: root-link metadata cache
- `sessions/<logical>/turns.jsonl`: logical session turn history

## 6) Dashboard

```bash
cd apps/lab-bench
ECOCLAW_STATE_DIR=/tmp/ecoclaw-plugin-state npm run web:cachetree
```

Open `http://127.0.0.1:7777` to inspect runtime decisions and compaction ROI.
