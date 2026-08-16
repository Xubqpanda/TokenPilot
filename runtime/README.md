# Development Runtime

TokenPilot experiments currently consume a local LightMem2 checkout.

```bash
export TOKENPILOT_RUNTIME_ROOT=/path/to/LightMem2
bash runtime/install-tokenpilot.sh
```

The bridge validates that the checkout exposes the release installer and then invokes `pnpm plugin:install:release`. It does not copy runtime source into the experiment repository and does not require an npm package.
