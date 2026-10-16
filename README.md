# MyFSS MCP

Full-text search over the accounting and disclosure supervision documents published by Korea's Financial Supervisory Service (FSS) and Financial Services Commission (FSC), served as a remote [MCP](https://modelcontextprotocol.io) server for accounting professionals.

The corpus covers eleven boards from 2010 onward: supervisory guidance (감독지침), audit review findings (심사·감리 지적사례), enforcement results (회계감리결과제재), model note disclosures (주석공시 모범사례), accounting supervision trends, external audit materials, ICFR (내부회계관리제도) materials, education materials, FSS and FSC press releases, and manually registered documents. Attachments (HWP, HWPX, PDF) are converted to Markdown so the body of each document is searchable and quotable, and every document carries a topic set, a document nature, and a two-sentence summary.

- Endpoint: `https://myfss.eocpa.kr/mcp` (Streamable HTTP, stateless)
- Credential: an eocpa token from [eocpa.kr/token](https://eocpa.kr/token)
- Nothing to install: register the URL in claude.ai, Claude Desktop, Claude Code, Cursor, or any Streamable HTTP client
- Landing page (Korean): [eocpa.kr/myfss](https://eocpa.kr/myfss)

## Why

What the regulator checks is written down: in review findings, in guidance, in the model disclosures it publishes. Those documents live as HWP attachments on a dozen bulletin boards and are not indexed anywhere a model can reach. This server makes them one searchable corpus with the attachment body included, so an answer about, say, convertible bond call options can cite the actual guidance paragraph and the actual enforcement case rather than a summary of them.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_documents` | `query?`, `topics?`, `nature?`, `board?`, `source?`, `dept?`, `date_from?`, `date_to?`, `limit?`, `offset?` | Document hits with summary, topics, departments, URL, and a snippet when a query matched; `total` for pagination |
| `get_document` | `ntt_id`, `max_chars?`, `offset_chars?` | Document metadata plus the attachment body as Markdown, paged with `offset_chars` |
| `list_recent` | `limit?`, `board?` | Latest documents by publication date |
| `list_tags` | — | The vocabulary that filters accept: topics, natures, boards (key and label), top departments |

Every tool is read-only, idempotent, and local (SQLite + FTS5). No external call is made while serving a request.

### Search behavior

- Tokens of three or more characters go to FTS5 (AND-joined, rank-ordered). One- and two-character tokens become `LIKE` filters, because the trigram index cannot match them.
- Filters without a query sweep a topic in publication-date order and return no snippet.
- `board` is asymmetric by design: the parameter takes an English key (`sanction_case`), the response shows the Korean label (`심사·감리 지적사례`). `list_tags` returns both.
- `summary` and `snippet` are for orientation. Quote `get_document`'s `body`.

## Using the server

### 1. Get a credential

Request an eocpa token at [eocpa.kr/token](https://eocpa.kr/token). Tool calls require it; discovery (`initialize`, `tools/list`, `ping`) works without one, so connector onboarding never fails on authentication.

### 2. Connect

The credential can travel in any of these slots; the server treats them identically:

| Slot | Example |
|---|---|
| Query string | `https://myfss.eocpa.kr/mcp?key=<token>` |
| Custom header | `x-eocpa-token: <token>` (also accepted: `x-api-key`) |
| Bearer | `Authorization: Bearer <token>` |

**claude.ai (web)** — the custom connector dialog takes a URL only, so put the token in the query string:

```
https://myfss.eocpa.kr/mcp?key=<token>
```

**Claude Desktop / Claude Code** — bridge with `mcp-remote` so the token stays in a header:

```json
{
  "mcpServers": {
    "myfss": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://myfss.eocpa.kr/mcp", "--header", "x-eocpa-token:${EOCPA_TOKEN}"],
      "env": { "EOCPA_TOKEN": "<token>" }
    }
  }
}
```

**Clients with a header field** (Cursor and others) — enter the endpoint and the `x-eocpa-token` header directly.

A Claude Code plugin manifest is included at [.claude-plugin/plugin.json](.claude-plugin/plugin.json), and [server.json](server.json) is the manifest for the official MCP Registry.

### 3. Check

```bash
curl https://myfss.eocpa.kr/health

curl -X POST https://myfss.eocpa.kr/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-eocpa-token: <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A tool call without a credential returns `401`; a credential that is present but rejected returns `403` with a message that says so. Requests are rate-limited per IP.

### PlayMCP channel

`https://myfss.eocpa.kr/mcp/playmcp` is the same server behind the same authentication, with the response contract the PlayMCP platform requires: every tool result stays within 24,000 characters. On this channel `get_document` defaults to `max_chars=18000` (the schema advertises that default; pass `max_chars` explicitly to override, and page with `offset_chars`). Results that would still exceed the budget are structurally truncated and flagged with `playmcp_truncated: true`, a `playmcp_truncation_note`, and `playmcp_text_truncated` on any object whose text was cut. The standard `/mcp` endpoint never truncates and keeps the 60,000-character default.

## Data and terms of use

The corpus (`data/fss.sqlite`) is **not** part of this repository. The source documents are publications of the FSS and the FSC; the Markdown bodies, topic tags, and summaries are derived from them. The hosted server is offered for reference by accounting practitioners; check the publishing agency's terms before redistributing document text.

## Development

Requires Node.js 22+.

```bash
git clone https://github.com/taesueocpa/myfss-mcp.git
cd myfss-mcp
npm install
npm run build
```

Running the server locally needs a corpus at `data/fss.sqlite` (schema in `src/store/fss-db.ts`), which this repository does not ship. The HTTP server boots without one and answers `503` on `/mcp` until it exists; stdio refuses to start.

```bash
npm run stdio     # stdio transport
npm start         # HTTP on :8080 — /mcp and /mcp/playmcp
```

| Environment variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 8080) |
| `FSS_DB_PATH` | Corpus location (default `data/fss.sqlite`) |
| `TOKEN_VALIDATE_URL` | Token validation endpoint (default `https://eocpa.kr/validate`) |
| `USAGE_DB_PATH` | Usage log location (default `data/usage.sqlite`) |
| `RATE_LIMIT_RPM`, `CORS_ORIGIN` | Per-IP request limit (default 300) and CORS origin (default `*`) |
| `PLAYMCP_LIMIT`, `PLAYMCP_LIMIT_UNIT` | PlayMCP channel budget (default `24000`, `chars`) |
| `MCP_ALLOWED_ORIGINS` | Comma-separated `Origin` allowlist for `/mcp` (DNS-rebinding guard). Requests without an `Origin` header and localhost origins always pass |

Layout:

```
src/main.ts          entry point (stdio by default, --http or MCP_MODE=http for remote)
src/tools/           tool registry — the single source of truth for both transports
src/server/          dispatch, server assembly, auth, token gate, rate limiter, HTTP wiring, PlayMCP profile and budget guard
src/store/           SQLite schema, FTS definition, usage log
src/search/          query tokenizer (FTS / LIKE split)
```

## Related

- [MyKIFRS MCP](https://github.com/taesueocpa/mykifrs-mcp) — Korean accounting standards and authoritative Q&A
- [eocpa.kr](https://eocpa.kr) — hub and token issuance
