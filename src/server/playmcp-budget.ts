export type PlaymcpLimitUnit = "bytes" | "chars";

export interface PlaymcpBudget {
  limit: number;
  unit: PlaymcpLimitUnit;
}

export const DEFAULT_PLAYMCP_LIMIT = 24_000;
export const PLAYMCP_LIMIT_FLOOR = 1_000;

const STRING_FLOOR = 256;
const ARRAY_FLOOR = 3;
const MAX_ROUNDS = 500;

const ARRAY_SENTINEL_PREFIX = "…[PlayMCP 상한: 이하 ";
const STRING_MARKER_RE = / …\[PlayMCP 상한: 이하 약 [\d,]+자 생략\]$/;

const TRUNCATED_KEY = "playmcp_truncated";
const TRUNCATION_NOTE_KEY = "playmcp_truncation_note";
const LOCAL_TRUNCATED_KEY = "playmcp_text_truncated";

let warnedInvalidLimit = false;
let warnedLowLimit = false;
let warnedInvalidUnit = false;

export function playmcpBudgetFromEnv(
  env: Record<string, string | undefined> = process.env,
): PlaymcpBudget {
  let limit = DEFAULT_PLAYMCP_LIMIT;
  const rawLimit = env.PLAYMCP_LIMIT;
  if (rawLimit !== undefined && rawLimit !== "") {
    const n = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(n) && n >= PLAYMCP_LIMIT_FLOOR) {
      limit = n;
    } else if (Number.isFinite(n) && n > 0) {
      limit = PLAYMCP_LIMIT_FLOOR;
      if (!warnedLowLimit) {
        warnedLowLimit = true;
        console.error(`PLAYMCP_LIMIT=${rawLimit} 은 스켈레톤 하한 미만 — ${PLAYMCP_LIMIT_FLOOR} 으로 클램프`);
      }
    } else if (!warnedInvalidLimit) {
      warnedInvalidLimit = true;
      console.error(`PLAYMCP_LIMIT 무효값 '${rawLimit}' — 기본 ${DEFAULT_PLAYMCP_LIMIT} 사용`);
    }
  }
  let unit: PlaymcpLimitUnit = "chars";
  const rawUnit = env.PLAYMCP_LIMIT_UNIT;
  if (rawUnit !== undefined && rawUnit !== "") {
    if (rawUnit === "bytes" || rawUnit === "chars") {
      unit = rawUnit;
    } else if (!warnedInvalidUnit) {
      warnedInvalidUnit = true;
      console.error(`PLAYMCP_LIMIT_UNIT 무효값 '${rawUnit}' — 기본 chars 사용`);
    }
  }
  return { limit, unit };
}

export function measureText(s: string, unit: PlaymcpLimitUnit): number {
  return unit === "chars" ? s.length : Buffer.byteLength(s, "utf8");
}

export function playmcpTruncationNote(budget: PlaymcpBudget, mainEndpoint: string): string {
  const unitLabel = budget.unit === "chars" ? "자" : "바이트";
  return (
    `PlayMCP 채널 응답 상한(${budget.limit.toLocaleString("en-US")}${unitLabel})에 맞춰 일부 내용이 생략되었습니다. ` +
    `limit·context·max_chars·offset 등 인자를 좁혀 나눠 조회하면 전체를 받을 수 있습니다. ` +
    `본문이 잘린 객체에는 ${LOCAL_TRUNCATED_KEY} 가 붙습니다 — 그 객체의 건수·길이 필드는 절단 전 원본 기준이라 ` +
    `실린 본문과 어긋날 수 있습니다. 상한 없는 표준 엔드포인트는 ${mainEndpoint} 입니다.`
  );
}

export function clampPlaymcpErrorText(message: string, budget: PlaymcpBudget): string {
  const reserve = 512;
  const room = Math.max(STRING_FLOOR, budget.limit - reserve);
  if (measureText(message, budget.unit) <= room) return message;
  return headByUnit(message, room, budget.unit) + " …[PlayMCP 상한: 이하 생략]";
}

function headByChars(s: string, n: number): string {
  let h = s.slice(0, Math.max(0, n));
  const last = h.charCodeAt(h.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) h = h.slice(0, -1);
  return h;
}

function headByUnit(s: string, n: number, unit: PlaymcpLimitUnit): string {
  if (n <= 0) return "";
  if (unit === "chars") return headByChars(s, n);
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= n) return s;
  return buf.subarray(0, n).toString("utf8").replace(/�+$/, "");
}

type StringSite = { parent: Record<PropertyKey, unknown> | unknown[]; key: PropertyKey; len: number };

function collectCandidates(
  node: unknown,
  arrays: unknown[][],
  strings: StringSite[],
  parent: Record<PropertyKey, unknown> | unknown[] | null,
  key: PropertyKey | null,
): void {
  if (typeof node === "string") {
    if (key === TRUNCATION_NOTE_KEY) return;
    if (node.length > STRING_FLOOR && parent !== null && key !== null) {
      strings.push({ parent, key, len: node.length });
    }
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    arrays.push(node);
    for (let i = 0; i < node.length; i++) collectCandidates(node[i], arrays, strings, node, i);
    return;
  }
  const obj = node as Record<PropertyKey, unknown>;
  for (const k of Object.keys(obj)) collectCandidates(obj[k], arrays, strings, obj, k);
}

function markerReserve(unit: PlaymcpLimitUnit): number {
  return measureText(" …[PlayMCP 상한: 이하 약 000,000,000자 생략]", unit);
}

function arrayBodyLen(arr: unknown[]): number {
  const last = arr[arr.length - 1];
  return typeof last === "string" && last.startsWith(ARRAY_SENTINEL_PREFIX) ? arr.length - 1 : arr.length;
}

function cutArray(arr: unknown[], originalLen: Map<unknown[], number>): boolean {
  const body = arrayBodyLen(arr);
  const keep = Math.max(ARRAY_FLOOR, Math.floor(body / 2));
  if (keep >= body) return false;
  if (!originalLen.has(arr)) originalLen.set(arr, body);
  const orig = originalLen.get(arr)!;
  arr.length = keep;
  arr.push(
    `${ARRAY_SENTINEL_PREFIX}${(orig - keep).toLocaleString("en-US")}개 항목 생략 — limit 등 인자를 좁혀 재조회]`,
  );
  return true;
}

function markLocalTruncation(site: StringSite): void {
  if (Array.isArray(site.parent)) return;
  const obj = site.parent as Record<PropertyKey, unknown>;
  const describedBySibling = Object.keys(obj).some(
    (k) => k !== site.key && k !== LOCAL_TRUNCATED_KEY && k !== TRUNCATED_KEY && k !== TRUNCATION_NOTE_KEY,
  );
  if (!describedBySibling) return;
  const prev = obj[LOCAL_TRUNCATED_KEY];
  const keys: string[] = Array.isArray(prev) ? prev.filter((k): k is string => typeof k === "string") : [];
  const name = String(site.key);
  if (!keys.includes(name)) keys.push(name);
  obj[LOCAL_TRUNCATED_KEY] = keys;
}

function cutString(
  site: StringSite,
  originalLen: Map<object, Map<PropertyKey, number>>,
  over: number,
  unit: PlaymcpLimitUnit,
): boolean {
  const val = (site.parent as Record<PropertyKey, unknown>)[site.key];
  if (typeof val !== "string") return false;
  const base = val.replace(STRING_MARKER_RE, "");
  const target = measureText(base, unit) - over - markerReserve(unit);
  let head = target > 0 ? headByUnit(base, target, unit) : "";
  if (head.length < STRING_FLOOR) head = headByChars(base, STRING_FLOOR);
  const keep = head.length;
  if (keep >= base.length) return false;
  let sites = originalLen.get(site.parent);
  if (!sites) {
    sites = new Map();
    originalLen.set(site.parent, sites);
  }
  if (!sites.has(site.key)) sites.set(site.key, base.length);
  const orig = sites.get(site.key)!;
  (site.parent as Record<PropertyKey, unknown>)[site.key] =
    `${head} …[PlayMCP 상한: 이하 약 ${(orig - head.length).toLocaleString("en-US")}자 생략]`;
  markLocalTruncation(site);
  return true;
}

function shrinkLargest(
  root: unknown,
  arrLens: Map<unknown[], number>,
  strLens: Map<object, Map<PropertyKey, number>>,
  over: number,
  unit: PlaymcpLimitUnit,
): boolean {
  const arrays: unknown[][] = [];
  const strings: StringSite[] = [];
  collectCandidates(root, arrays, strings, null, null);

  let bestArr: unknown[] | null = null;
  let bestArrWeight = 0;
  for (const a of arrays) {
    if (arrayBodyLen(a) <= ARRAY_FLOOR) continue;
    const w = JSON.stringify(a).length;
    if (w > bestArrWeight) {
      bestArrWeight = w;
      bestArr = a;
    }
  }
  let bestStr: StringSite | null = null;
  for (const s of strings) if (!bestStr || s.len > bestStr.len) bestStr = s;

  if (bestArr && (!bestStr || bestArrWeight >= bestStr.len)) {
    if (cutArray(bestArr, arrLens)) return true;
  }
  if (bestStr && cutString(bestStr, strLens, over, unit)) return true;
  if (bestArr && cutArray(bestArr, arrLens)) return true;
  return false;
}

function previewFallback(fullSerialized: string, budget: PlaymcpBudget, note: string): unknown {
  const fallbackNote = `${note} (구조 절단이 불가능한 응답 형태라 직렬화 앞부분만 담았습니다.)`;
  let room = Math.max(
    0,
    budget.limit -
      measureText(JSON.stringify({ [TRUNCATED_KEY]: true, [TRUNCATION_NOTE_KEY]: fallbackNote, preview: "" }), budget.unit) -
      64,
  );
  for (let i = 0; i < 12; i++) {
    const candidate = {
      [TRUNCATED_KEY]: true,
      [TRUNCATION_NOTE_KEY]: fallbackNote,
      preview: headByUnit(fullSerialized, room, budget.unit),
    };
    if (measureText(JSON.stringify(candidate), budget.unit) <= budget.limit || room === 0) return candidate;
    room = Math.floor(room / 2);
  }
  return { [TRUNCATED_KEY]: true, [TRUNCATION_NOTE_KEY]: fallbackNote, preview: "" };
}

export function enforcePlaymcpBudget(
  result: unknown,
  budget: PlaymcpBudget,
  mainEndpoint: string,
): { result: unknown; truncated: boolean } {
  const s0 = JSON.stringify(result);
  if (s0 === undefined) return { result, truncated: false };
  if (measureText(s0, budget.unit) <= budget.limit) return { result, truncated: false };

  let work: unknown = JSON.parse(s0);
  const note = playmcpTruncationNote(budget, mainEndpoint);
  if (work !== null && typeof work === "object" && !Array.isArray(work)) {
    (work as Record<string, unknown>)[TRUNCATED_KEY] = true;
    (work as Record<string, unknown>)[TRUNCATION_NOTE_KEY] = note;
  } else {
    work = { [TRUNCATED_KEY]: true, [TRUNCATION_NOTE_KEY]: note, value: work };
  }

  const arrLens = new Map<unknown[], number>();
  const strLens = new Map<object, Map<PropertyKey, number>>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const s = JSON.stringify(work);
    const over = measureText(s, budget.unit) - budget.limit;
    if (over <= 0) return { result: work, truncated: true };
    if (!shrinkLargest(work, arrLens, strLens, over, budget.unit))
      return { result: previewFallback(s0, budget, note), truncated: true };
  }
  return { result: previewFallback(s0, budget, note), truncated: true };
}
