import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [],
    includeSource: [
      'src/**/*.mjs',
      'vscode/src/document.mjs',
      'vscode/src/ipadic.mjs',
      'vscode/src/l10n.mjs',
      'vscode/src/markup.mjs',
      'vscode/src/pdf-renderer.mjs',
      'vscode/src/prose.mjs',
      'vscode/src/reorder.mjs',
      'vscode/src/work-settings.mjs',
    ],
    environment: 'node',
  },
  define: {
    'import.meta.vitest': 'undefined',
  },
});
