import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

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

  const workerSrc = join(
    process.cwd(),
    "..",
    "layers",
    "execution",
    "src",
    "reduction",
    "semantic-llmlingua2-worker.py",
  );
  const workerDest = join(process.cwd(), "dist", "semantic-llmlingua2-worker.py");
  await mkdir(dirname(workerDest), { recursive: true });
  await copyFile(workerSrc, workerDest);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
