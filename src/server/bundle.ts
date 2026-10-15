import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export interface ClientBundle {
  js: string;
  css: string;
}

const ENTRY = fileURLToPath(new URL('../web/main.tsx', import.meta.url));

let pending: Promise<ClientBundle> | undefined;

/**
 * Bundles the React client in memory. Takes well under a second, so there is
 * no separate build step and `xray serve` always serves the current sources.
 */
export function bundleClient(): Promise<ClientBundle> {
  pending ??= build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    outdir: 'assets',
    entryNames: 'app',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })
    .then((result) => ({
      js: result.outputFiles.find((file) => file.path.endsWith('.js'))?.text ?? '',
      css: result.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '',
    }))
    .catch((error: unknown) => {
      pending = undefined; // let the next request retry
      throw error;
    });
  return pending;
}
