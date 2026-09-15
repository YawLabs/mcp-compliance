import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    // Most suites spawn fixture servers (node children, often several per
    // test). One worker per core left no CPU for them: on a 12-core machine
    // fresh children missed their startup budgets and hooks timed out, and
    // the run was slower (87s) than with half the workers (59s).
    maxWorkers: "50%",
  },
});
