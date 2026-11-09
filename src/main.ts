import { CorpusError } from "./core/errors.js";

const mode = process.argv.includes("--http") || process.env.MCP_MODE === "http" ? "http" : "stdio";

try {
  if (mode === "http") {
    const { serveHttp } = await import("./server/http.js");
    await serveHttp();
  } else {
    const { serveStdio } = await import("./server/stdio.js");
    await serveStdio();
  }
} catch (err) {
  console.error(err instanceof CorpusError ? err.message : err);
  process.exit(1);
}
