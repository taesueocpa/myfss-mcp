// stdout 은 MCP 프로토콜이 쓴다. 로그는 console.error 로만
import { serveStdio as sdkServeStdio } from "@modelcontextprotocol/server/stdio";
import { openCorpus } from "../store/fss-db.js";
import { UsageDb, type Session } from "../store/usage-db.js";
import { buildServer } from "./build-server.js";
import { SERVER_NAME } from "../version.js";

export async function serveStdio(): Promise<void> {
  const corpus = openCorpus();
  const usage = new UsageDb();
  const session: Session = { userHash: null, isOwner: true, transport: "stdio" };
  sdkServeStdio(() => buildServer({ corpus, usage, session }));
  console.error(`${SERVER_NAME} MCP 서버 시작 (stdio, dual-era)`);
}
