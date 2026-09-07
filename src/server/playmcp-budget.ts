/**
 * [PlayMCP] /mcp/playmcp 채널 전용 응답 예산 가드.
 *
 * PlayMCP 플랫폼은 Tool Response 가 24,000자를 넘으면 에러로 처리한다. 메인 /mcp 는 무절단을 유지하고
 * (전문·문맥을 그대로 돌려주는 것이 이 서버의 목적), PlayMCP 등록 URL 이 가리키는 /mcp/playmcp
 * 만 이 가드를 통과한다 — 초과 호출이 플랫폼에서 그냥 실패하는 대신, 구조를 보존한 채 예산
 * 안으로 줄여 유효한 응답으로 내보낸다.
 *
 * 이 가드는 최후 보루다. 도구 기본값이 평범한 호출에서 예산을 넘는 경우는 채널 기본값
 * (ToolSpec.liteDefaults)으로 앞단에서 막고, 여기는 그래도 넘치는 꼬리만 받는다.
 *
 * 규율:
 *  - 절단이 일어나는 어떤 경로도 예산 초과 응답을 내보내지 않는다(구조 절단 불능 형태는 preview 폴백).
 *  - 절단은 침묵하지 않는다 — `playmcp_truncated: true` + `playmcp_truncation_note` 를 항상 싣는다.
 *  - JSON 유효성 보존 — 직렬화 문자열을 자르지 않고 값 그래프에서 가장 큰 기여자(최대 배열의 꼬리·
 *    최장 문자열)를 줄인다. 배열은 head 보존, 문자열은 예산에 모자란 만큼만 자른다.
 *  - 문자열을 자른 객체에는 `playmcp_text_truncated`(잘린 키 목록)를 붙인다 — 같은 객체의 건수·길이
 *    필드는 절단 전 원본을 기술한 채 남으므로, 해석 기준을 그 자리에서 밝힌다.
 *  - 단위는 PLAYMCP_LIMIT_UNIT(기본 chars). env 는 정책 변동 대비 오버라이드로만 남긴다.
 */

export type PlaymcpLimitUnit = "bytes" | "chars";

export interface PlaymcpBudget {
  limit: number;
  unit: PlaymcpLimitUnit;
}

export const DEFAULT_PLAYMCP_LIMIT = 24_000;
/** PLAYMCP_LIMIT 하한 — note·preview 스켈레톤이 절단 대상이 아니라 그 밑의 예산은 구조적으로 지킬 수 없다. */
export const PLAYMCP_LIMIT_FLOOR = 1_000;

/** 문자열 절단이 이 밑으로는 내려가지 않는다 — 안내문·센티널이 절단 대상이 되지 않는 방어선. */
const STRING_FLOOR = 256;
/** 배열은 최소 이 개수의 실제 항목을 남긴다(센티널 제외) — 형태를 보고 재조회할 수 있어야 한다. */
const ARRAY_FLOOR = 3;
/** 반감 수렴 안전핀. */
const MAX_ROUNDS = 500;

const ARRAY_SENTINEL_PREFIX = "…[PlayMCP 상한: 이하 ";
const STRING_MARKER_RE = / …\[PlayMCP 상한: 이하 약 [\d,]+자 생략\]$/;

const TRUNCATED_KEY = "playmcp_truncated";
const TRUNCATION_NOTE_KEY = "playmcp_truncation_note";
const LOCAL_TRUNCATED_KEY = "playmcp_text_truncated";

let warnedInvalidLimit = false;
let warnedLowLimit = false;
let warnedInvalidUnit = false;

/** PLAYMCP_LIMIT · PLAYMCP_LIMIT_UNIT 판독 — 요청마다 재판독해도 되는 비용이라 라이브 토글로 남긴다. */
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

/** 단위별 크기 측정. chars 는 UTF-16 코드유닛(String.length) — 한글 음절은 전부 BMP 라 '자'와 같다. */
export function measureText(s: string, unit: PlaymcpLimitUnit): number {
  return unit === "chars" ? s.length : Buffer.byteLength(s, "utf8");
}

/** note 문구 — 모델이 복구 경로(인자 좁히기·표준 엔드포인트)를 바로 알게 한다. */
export function playmcpTruncationNote(budget: PlaymcpBudget, mainEndpoint: string): string {
  const unitLabel = budget.unit === "chars" ? "자" : "바이트";
  return (
    `PlayMCP 채널 응답 상한(${budget.limit.toLocaleString("en-US")}${unitLabel})에 맞춰 일부 내용이 생략되었습니다. ` +
    `limit·context·max_chars·offset 등 인자를 좁혀 나눠 조회하면 전체를 받을 수 있습니다. ` +
    `본문이 잘린 객체에는 ${LOCAL_TRUNCATED_KEY} 가 붙습니다 — 그 객체의 건수·길이 필드는 절단 전 원본 기준이라 ` +
    `실린 본문과 어긋날 수 있습니다. 상한 없는 표준 엔드포인트는 ${mainEndpoint} 입니다.`
  );
}

/** isError 응답도 Tool Response 다 — 오류 메시지가 예산을 넘으면 꼬리를 클램프해 안내 머리를 보존한다. */
export function clampPlaymcpErrorText(message: string, budget: PlaymcpBudget): string {
  const reserve = 512;
  const room = Math.max(STRING_FLOOR, budget.limit - reserve);
  if (measureText(message, budget.unit) <= room) return message;
  return headByUnit(message, room, budget.unit) + " …[PlayMCP 상한: 이하 생략]";
}

/** UTF-16 head 절단 — 서로게이트 반쪽이 꼬리에 남지 않게 한다. */
function headByChars(s: string, n: number): string {
  let h = s.slice(0, Math.max(0, n));
  const last = h.charCodeAt(h.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) h = h.slice(0, -1);
  return h;
}

/** 단위 기준 head 절단 — bytes 는 코드포인트 경계 보존(꼬리의 대체문자 제거). */
function headByUnit(s: string, n: number, unit: PlaymcpLimitUnit): string {
  if (n <= 0) return "";
  if (unit === "chars") return headByChars(s, n);
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= n) return s;
  return buf.subarray(0, n).toString("utf8").replace(/�+$/, "");
}

type StringSite = { parent: Record<PropertyKey, unknown> | unknown[]; key: PropertyKey; len: number };

/** 값 그래프에서 절단 후보 수집 — 배열 전부 + STRING_FLOOR 초과 문자열 leaf. 가드 자신의 안내문은 제외. */
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

/** 문자열 절단 마커의 자리 — 생략 자수의 자릿수를 모르므로 9자리 기준 최대치로 잡는다. */
function markerReserve(unit: PlaymcpLimitUnit): number {
  return measureText(" …[PlayMCP 상한: 이하 약 000,000,000자 생략]", unit);
}

function arrayBodyLen(arr: unknown[]): number {
  const last = arr[arr.length - 1];
  return typeof last === "string" && last.startsWith(ARRAY_SENTINEL_PREFIX) ? arr.length - 1 : arr.length;
}

/** 배열 꼬리 반감 + 생략 개수 센티널(재절단 시 원래 길이 기준으로 갱신). */
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

/** 잘린 문자열이 든 객체에 국소 표식을 남긴다. 형제 필드는 손대지 않는다(가드는 필드의 뜻을 모른다). */
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

/** 문자열 절단 — 반감이 아니라 예산에 모자란 만큼(over)만 자른다. 마커 자리를 미리 뺀다. */
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

/** 한 라운드: 가장 큰 기여자(최대 배열 vs 최장 문자열)를 골라 줄인다. 더 줄일 것이 없으면 false. */
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

/** 구조 절단 불능(키 폭발 등) 최후 폴백 — 직렬화 head 를 preview 로 담는다. */
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

/**
 * 도구 결과(JSON 값)의 예산 집행. 예산 내면 원본 그대로(무비용 통과), 초과면 와이어 형태 클론
 * (JSON.parse(JSON.stringify)) 위에서 구조 보존 절단. 원본 result 는 불변이다.
 */
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
