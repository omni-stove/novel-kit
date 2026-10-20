import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [],
    includeSource: ['src/**/*.mjs', 'vscode/src/document.mjs', 'vscode/src/markup.mjs', 'vscode/src/pdf-renderer.mjs'],
    environment: 'node',
  },
  define: {
    'import.meta.vitest': 'undefined',
  },
});
