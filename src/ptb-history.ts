/** Recorded PTB timeline: REST openPrice changes, plus Gamma at window end. */

export type PtbHistorySource = "rest" | "gamma";

export interface PtbHistoryEntry {
  /** Unix seconds when this PTB became active. Gamma uses windowEnd. */
  t: number;
  ptb: number;
  source: PtbHistorySource;
}

const SOURCE_CODE = {
  rest: 1,
  gamma: 2,
} as const;

export function appendPtbHistory(
  history: PtbHistoryEntry[] | undefined,
  entry: PtbHistoryEntry,
): PtbHistoryEntry[] {
  const ptb = Number(entry.ptb);
  const t = Number(entry.t);
  if (!Number.isFinite(ptb) || !Number.isFinite(t)) {
    return history ? [...history] : [];
  }
  const next = history ? [...history] : [];
  const last = next[next.length - 1];
  if (last && last.ptb === ptb && last.source === entry.source) return next;
  next.push({ t, ptb, source: entry.source });
  return next;
}

/** PTB in force at `atSec`. Gamma only applies at/after windowEnd. */
export function resolvePtbAt(
  history: PtbHistoryEntry[] | undefined,
  atSec: number,
  windowEnd?: number,
): PtbHistoryEntry | undefined {
  if (!history?.length || !Number.isFinite(atSec)) return undefined;
  const atEnd =
    windowEnd != null && Number.isFinite(windowEnd) && atSec >= windowEnd - 1e-9;
  if (atEnd) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]!.source === "gamma") return history[i];
    }
  }
  let found: PtbHistoryEntry | undefined;
  for (const entry of history) {
    if (entry.source === "gamma") continue;
    if (entry.t <= atSec + 1e-9) found = entry;
  }
  return found;
}

export function encodePtbHistory(
  history: PtbHistoryEntry[] | undefined,
): Array<[number, number, number]> | undefined {
  if (!history?.length) return undefined;
  const rows: Array<[number, number, number]> = [];
  for (const entry of history) {
    const t = Number(entry.t);
    const ptb = Number(entry.ptb);
    if (!Number.isFinite(t) || !Number.isFinite(ptb)) continue;
    rows.push([t, ptb, entry.source === "gamma" ? SOURCE_CODE.gamma : SOURCE_CODE.rest]);
  }
  return rows.length ? rows : undefined;
}

export function decodePtbHistory(raw: unknown): PtbHistoryEntry[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: PtbHistoryEntry[] = [];
  for (const row of raw) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const rec = row as { t?: unknown; ptb?: unknown; source?: unknown };
      const t = Number(rec.t);
      const ptb = Number(rec.ptb);
      const source: PtbHistorySource = rec.source === "gamma" ? "gamma" : "rest";
      if (Number.isFinite(t) && Number.isFinite(ptb)) out.push({ t, ptb, source });
      continue;
    }
    if (!Array.isArray(row) || row.length < 2) continue;
    const t = Number(row[0]);
    const ptb = Number(row[1]);
    const source: PtbHistorySource = Number(row[2]) === SOURCE_CODE.gamma ? "gamma" : "rest";
    if (Number.isFinite(t) && Number.isFinite(ptb)) out.push({ t, ptb, source });
  }
  return out.length ? out : undefined;
}

export function recordingPtbFields(doc: {
  ptbHistory?: PtbHistoryEntry[];
  gammaPtb?: number;
}): { ptbHistory?: PtbHistoryEntry[]; gammaPtb?: number } {
  const out: { ptbHistory?: PtbHistoryEntry[]; gammaPtb?: number } = {};
  if (doc.ptbHistory?.length) out.ptbHistory = doc.ptbHistory;
  if (doc.gammaPtb != null && Number.isFinite(doc.gammaPtb)) out.gammaPtb = doc.gammaPtb;
  return out;
}
