// Feature 009 (research R15, contracts/website-button.md §2): builds the website chat button into one
// static file, dist/widget/widget.js: the script and the shared page rule matcher in an ES2019 IIFE.
// Run by the api `build` script; the unit tests build it in memory with the same options.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The esbuild options of the bundle (no file written). */
export const widgetBuildOptions = {
  entryPoints: [path.join(apiRoot, 'src/widget/chat-button.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2019',
  minify: true,
  legalComments: 'none',
  write: false,
  logLevel: 'silent',
};

/** The bundled script as text. */
export async function buildWidget() {
  const result = await build(widgetBuildOptions);
  return result.outputFiles[0].text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = path.join(apiRoot, 'dist/widget/widget.js');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, await buildWidget());
  console.log(`widget: ${out}`);
}
