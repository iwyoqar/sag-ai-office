import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Test processes are capped: each fork loads the whole server (Fastify, SQLite, migrations, seed) and several tests
// start worker threads that compile TypeScript again. Vitest's default (one fork per core) oversubscribes CPU and
// memory as soon as two suites run at once, and then ordinary tests miss their 5 s budget for reasons that have
// nothing to do with the code under test. Override with VITEST_MAX_FORKS.
const maxForks = Number(process.env.VITEST_MAX_FORKS) || Math.max(2, Math.min(6, Math.floor(availableParallelism() / 2)));

export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    pool: "forks",
    poolOptions: { forks: { maxForks, minForks: 1 } },
  },
});
