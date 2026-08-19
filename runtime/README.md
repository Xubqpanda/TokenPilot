# Development Runtime

TokenPilot experiments currently consume a local LightRSI checkout.

```bash
export TOKENPILOT_RUNTIME_ROOT=/path/to/LightRSI
bash runtime/install-tokenpilot.sh
```

The bridge validates that the checkout exposes the release installer and then invokes `pnpm plugin:install:release`. It does not copy runtime source into the experiment repository and does not require an npm package.
