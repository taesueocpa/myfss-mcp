/**
 * 유일한 진입점 — 실행 형태는 서버 둘뿐이고 여기서 분기한다.
 *
 *   stdio (기본)      : npx tsx src/main.ts
 *   HTTP (원격/배포)  : MCP_MODE=http node build/main.js
 *
 * --http 인자는 MCP_MODE=http 와 같은 분기의 다른 표기다. CLI 서브커맨드는 없다.
 */
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
