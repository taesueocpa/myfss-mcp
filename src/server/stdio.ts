/**
 * 로컬 stdio 모드 (로컬 Claude Code용). (MCP SDK v2 — dual-era)
 *
 * 주의: stdio 프로토콜이 stdout 을 쓰므로 로그는 반드시 console.error 로.
 * 로컬 stdio 는 운영자 본인이다 — usage 세션은 is_owner=1, user_hash 없음.
 *
 * SDK 의 `serveStdio` 는 **연결마다 팩토리를 부른다** — 2025-era 핸드셰이크로 열린 연결은 그 era 에
 * 고정돼 서빙되고, 모던 클라이언트의 `server/discover` 프로브도 같은 팩토리로 응답한다.
 */
import { serveStdio as sdkServeStdio } from "@modelcontextprotocol/server/stdio";
import { openCorpus } from "../store/fss-db.js";
import { UsageDb, type Session } from "../store/usage-db.js";
import { buildServer } from "./build-server.js";
import { SERVER_NAME } from "../version.js";

export async function serveStdio(): Promise<void> {
  const corpus = openCorpus(); // 부팅 검증 포함(파일 존재·docs_fts) — 실패는 CorpusError
  const usage = new UsageDb(); // 기록은 절대 throw 하지 않는다(sink 소관)
  const session: Session = { userHash: null, isOwner: true, transport: "stdio" };
  sdkServeStdio(() => buildServer({ corpus, usage, session }));
  console.error(`${SERVER_NAME} MCP 서버 시작 (stdio, dual-era)`);
}
