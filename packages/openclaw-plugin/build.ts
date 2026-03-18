import { build } from "esbuild";

async function main() {
  await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: "dist/index.js",
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    minify: false,
    logLevel: "info",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
