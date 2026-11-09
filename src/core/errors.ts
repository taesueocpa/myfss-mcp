export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}

export class BusyError extends Error {
  readonly scope: "slow";
  constructor(message: string, scope: "slow") {
    super(message);
    this.name = "BusyError";
    this.scope = scope;
  }
}

export class ClientAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientAbortedError";
  }
}

export function classifyError(err: unknown): string {
  if (err instanceof BusyError) return `busy:${err.scope}`;
  if (err instanceof ClientAbortedError) return "client_aborted";
  if (err && typeof err === "object" && (err as { name?: string }).name === "ZodError") return "validation";
  const msg = err instanceof Error ? err.message : String(err);
  return "other:" + msg.replace(/\s+/g, " ").trim().slice(0, 80);
}
