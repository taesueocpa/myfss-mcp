import { CorpusError } from "./core/errors.js";
import { serveStdio } from "./server/stdio.js";

try {
  await serveStdio();
} catch (err) {
  console.error(err instanceof CorpusError ? err.message : err);
  process.exit(1);
}
