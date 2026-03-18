# EcoClaw OpenClaw Plugin

Install:

```bash
openclaw plugins install ecoclaw
openclaw gateway restart
```

Optional proxy routing mode:

```bash
openclaw config set plugins.entries.ecoclaw.config.proxyBaseUrl "http://127.0.0.1:8787/v1"
openclaw config set plugins.entries.ecoclaw.config.proxyApiKey "sk-xxx"
openclaw gateway restart
```

Optional debug logs:

```bash
openclaw config set plugins.entries.ecoclaw.config.logLevel debug
openclaw gateway restart
```
