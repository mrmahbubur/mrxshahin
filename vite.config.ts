import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

function resolveViteBasePath(): string {
  const raw = (process.env.VITE_BASE_PATH || '/').trim();
  if (!raw || raw === '/') return '/';
  if (raw === './' || raw === '.') return './';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

export default defineConfig(() => {
  const base = resolveViteBasePath();
  let resolvedOutDir = 'dist';

  return {
    base,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'rewrite-html-base-links',
        transformIndexHtml(html) {
          let next = html;
          if (base !== '/') {
            const cleanBase = base === './' ? './' : base;
            next = next.replace('href="/rss.xml"', `href="${cleanBase}rss.xml"`);
          }
          return next;
        },
      },
      {
        name: 'strip-raw-gh-redirect-in-build',
        apply: 'build',
        transformIndexHtml(html) {
          return html.replace(/<script\s+data-raw-gh-redirect>[\s\S]*?<\/script>\s*/gi, '');
        },
      },
      // Copies src/assets into build outDir so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        configResolved(config) {
          resolvedOutDir = config.build.outDir || 'dist';
        },
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const outDir = path.resolve(__dirname, resolvedOutDir);
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const outAssets = path.resolve(outDir, 'src/assets');
          if (fs.existsSync(outDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, outAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
