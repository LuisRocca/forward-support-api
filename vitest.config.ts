import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    coverage: {
      provider: 'v8',
      // lcov para SonarQube; el reporter por defecto de v8 no lo genera.
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage/unit',
      include: ['src/**/*.ts'],
      // El cliente generado y los dobles de test no son código a cubrir.
      exclude: ['src/generated/**', 'src/**/*.spec.ts', 'src/**/test-doubles.ts'],
    },
    include: ['**/*.spec.ts'],
  },
});
