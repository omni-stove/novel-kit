import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [],
    includeSource: ['src/**/*.mjs', 'vscode/src/document.mjs'],
    environment: 'node',
  },
  define: {
    'import.meta.vitest': 'undefined',
  },
});
