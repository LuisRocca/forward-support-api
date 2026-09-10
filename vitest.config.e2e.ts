import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    coverage: {
      provider: 'v8',
      // lcov para SonarQube; el reporter por defecto de v8 no lo genera.
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage/e2e',
      include: ['src/**/*.ts'],
      // El cliente generado y los dobles de test no son código a cubrir.
      exclude: ['src/generated/**', 'src/**/*.spec.ts', 'src/**/test-doubles.ts'],
    },
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // En serie: todos los ficheros comparten la base de test y hacen upsert de
    // los mismos roles; en paralelo chocarían contra la restricción única.
    fileParallelism: false,
  },
});
