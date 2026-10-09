import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'path';
import {defineConfig, loadEnv, type Plugin} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { visualizer } from 'rollup-plugin-visualizer';

const CODEMIRROR_RENDER_AHEAD_SCREENS = 3;
const appVersion = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

function buildCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * CodeMirror intentionally keeps its DOM viewport small and does not expose
 * its pixel margin as a public facet. Open embeds are block widgets, so they
 * cannot mount their real nested editors until that viewport reaches them.
 * Patch the pinned CodeMirror build at bundle time to keep three screen
 * heights of the real renderer ready on either side of the visible panel.
 *
 * Keeping this as a build transform (rather than editing node_modules) makes
 * installs reproducible. The explicit pattern checks fail loudly when a
 * future CodeMirror update changes the relevant viewport implementation.
 */
function addCodeMirrorRenderAhead(source: string) {
  if (source.includes('mathNoteRenderAheadMargin')) return source;

  const replacements: Array<[string, string]> = [
    [
      'let marginTop = 0.5 - Math.max(-0.5, Math.min(0.5, bias / 1000 /* VP.Margin */ / 2));',
      `let viewHeight = Math.max(1, Math.min(this.editorHeight, this.pixelViewport.bottom - this.pixelViewport.top));\n        let mathNoteRenderAheadMargin = Math.max(1000, viewHeight * ${CODEMIRROR_RENDER_AHEAD_SCREENS * 2});\n        let marginTop = 0.5 - Math.max(-0.5, Math.min(0.5, bias / mathNoteRenderAheadMargin / 2));`
    ],
    [
      'let viewport = new Viewport(map.lineAt(visibleTop - marginTop * 1000 /* VP.Margin */, QueryType.ByHeight, oracle, 0, 0).from, map.lineAt(visibleBottom + (1 - marginTop) * 1000 /* VP.Margin */, QueryType.ByHeight, oracle, 0, 0).to);',
      `let viewport = new Viewport(map.lineAt(visibleTop - marginTop * mathNoteRenderAheadMargin, QueryType.ByHeight, oracle, 0, 0).from, map.lineAt(visibleBottom + (1 - marginTop) * mathNoteRenderAheadMargin, QueryType.ByHeight, oracle, 0, 0).to);\n        // Keep already-rendered rows until they are five screens away. This\n        // hysteresis prevents a measured nested editor from being replaced by\n        // an estimate at the three-screen preparation boundary.\n        let mathNoteRetainDistance = viewHeight * 5;\n        if (this.viewport) {\n            if (this.viewport.from < viewport.from) {\n                let retainedTop = map.lineAt(this.viewport.from, QueryType.ByPos, oracle, 0, 0).top;\n                if (retainedTop >= visibleTop - mathNoteRetainDistance)\n                    viewport = new Viewport(this.viewport.from, viewport.to);\n            }\n            if (this.viewport.to > viewport.to) {\n                let retainedBottom = map.lineAt(this.viewport.to, QueryType.ByPos, oracle, 0, 0).bottom;\n                if (retainedBottom <= visibleBottom + mathNoteRetainDistance)\n                    viewport = new Viewport(viewport.from, this.viewport.to);\n            }\n        }`
    ],
    [
      'let viewHeight = Math.min(this.editorHeight, this.pixelViewport.bottom - this.pixelViewport.top);\n                let block = map.lineAt(head, QueryType.ByPos, oracle, 0, 0), topPos;',
      'let block = map.lineAt(head, QueryType.ByPos, oracle, 0, 0), topPos;'
    ],
    [
      'viewport = new Viewport(map.lineAt(topPos - 1000 /* VP.Margin */ / 2, QueryType.ByHeight, oracle, 0, 0).from, map.lineAt(topPos + viewHeight + 1000 /* VP.Margin */ / 2, QueryType.ByHeight, oracle, 0, 0).to);',
      'viewport = new Viewport(map.lineAt(topPos - mathNoteRenderAheadMargin / 2, QueryType.ByHeight, oracle, 0, 0).from, map.lineAt(topPos + viewHeight + mathNoteRenderAheadMargin / 2, QueryType.ByHeight, oracle, 0, 0).to);'
    ],
    [
      'let { visibleTop, visibleBottom } = this;\n        return (from == 0 || top <= visibleTop',
      `let { visibleTop, visibleBottom } = this;\n        let viewHeight = Math.max(1, Math.min(this.editorHeight, this.pixelViewport.bottom - this.pixelViewport.top));\n        let mathNoteRenderAheadMargin = Math.max(1000, viewHeight * ${CODEMIRROR_RENDER_AHEAD_SCREENS * 2});\n        let mathNoteMarginTop = 0.5 - Math.max(-0.5, Math.min(0.5, bias / mathNoteRenderAheadMargin / 2));\n        return (from == 0 || top <= visibleTop`
    ],
    [
      'top <= visibleTop - Math.max(10 /* VP.MinCoverMargin */, Math.min(-bias, 250 /* VP.MaxCoverMargin */)))',
      'top <= visibleTop - Math.max(10 /* VP.MinCoverMargin */, mathNoteMarginTop * mathNoteRenderAheadMargin * 0.9))'
    ],
    [
      'bottom >= visibleBottom + Math.max(10 /* VP.MinCoverMargin */, Math.min(bias, 250 /* VP.MaxCoverMargin */)))',
      'bottom >= visibleBottom + Math.max(10 /* VP.MinCoverMargin */, (1 - mathNoteMarginTop) * mathNoteRenderAheadMargin * 0.9))'
    ],
    [
      '(top > visibleTop - 2 * 1000 /* VP.Margin */ && bottom < visibleBottom + 2 * 1000 /* VP.Margin */);',
      '(top > visibleTop - 2 * mathNoteRenderAheadMargin && bottom < visibleBottom + 2 * mathNoteRenderAheadMargin);'
    ]
  ];

  let patched = source;
  for (const [needle, replacement] of replacements) {
    if (!patched.includes(needle)) {
      throw new Error('The pinned CodeMirror viewport implementation changed; update the three-screen render-ahead transform.');
    }
    patched = patched.replace(needle, replacement);
  }
  return patched;
}

function codeMirrorRenderAheadPlugin(): Plugin {
  const isCodeMirrorView = (id: string) => id.split('?')[0].replaceAll('\\', '/').endsWith('/@codemirror/view/dist/index.js');
  return {
    name: 'math-note-codemirror-render-ahead',
    enforce: 'pre',
    transform(code, id) {
      if (!isCodeMirrorView(id)) return null;
      return { code: addCodeMirrorRenderAhead(code), map: null };
    }
  };
}

function codeMirrorRenderAheadEsbuildPlugin() {
  return {
    name: 'math-note-codemirror-render-ahead',
    setup(build: { onLoad: (options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ contents: string; loader: 'js' }>) => void }) {
      build.onLoad({ filter: /@codemirror[\\/]view[\\/]dist[\\/]index\.js$/ }, async args => ({
        contents: addCodeMirrorRenderAhead(await fs.promises.readFile(args.path, 'utf8')),
        loader: 'js'
      }));
    }
  };
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', 'VITE_');
  const base = env.VITE_BASE_PATH || '/';
  const isProductionBuild = mode === 'production';
  return {
    base,
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __BUILD_COMMIT__: JSON.stringify(isProductionBuild ? buildCommit() : ''),
      __BUILD_TIME__: JSON.stringify(isProductionBuild ? new Date().toISOString() : '')
    },
    plugins: [
      codeMirrorRenderAheadPlugin(),
      react(), 
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        devOptions: {
          // The disposable test server must not register a persistent worker:
          // it would otherwise serve yesterday's editor after a reload.
          enabled: !process.argv.includes('--test-mode')
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
        },
        manifest: {
          name: 'Math Note Editor',
          short_name: 'MathNotes',
          description: 'A mathematical note taking app.',
          theme_color: '#0f1115',
          background_color: '#0f1115',
          display: 'standalone',
          start_url: base,
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable'
            }
          ]
        }
      }),
      env.VITE_BUNDLE_ANALYZE === 'true' && visualizer({
        filename: 'bundle-report.html',
        template: 'treemap',
        gzipSize: true,
        brotliSize: true,
        open: false
      })
    ].filter(Boolean),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
      dedupe: ['react', 'react-dom']
    },
    optimizeDeps: {
      // The render-ahead transform is an in-memory dependency transform, so
      // Vite's lockfile-only cache key cannot tell when it changes. Rebuild the
      // optimized dependency on server start to guarantee dev/test parity with
      // the production bundle.
      force: true,
      esbuildOptions: {
        plugins: [codeMirrorRenderAheadEsbuildPlugin()]
      }
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // File watching is disabled for workspace data to avoid reloads during saves.
      watch: { ignored: ['**/blocks/**', '**/macros.json', '**/.playwright-results/**', '**/dist/**', '**/desktop-server/**', '**/dev-dist/**'] },
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
