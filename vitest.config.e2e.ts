import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // En serie: todos los ficheros comparten la base de test y hacen upsert de
    // los mismos roles; en paralelo chocarían contra la restricción única.
    fileParallelism: false,
  },
});
