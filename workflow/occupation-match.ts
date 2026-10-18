/** Pure helpers for the occupation/industry search widget (unit-testable without a browser). */
export function stripCode(value: string): string {
  return value.trim().replace(/^[A-Z]?\d{6}\s+/, "");
}

/** Index of the best label for `expected`: exact > code-stripped exact > contains. -1 if none or ambiguous at the best tier. */
export function pickResult(labels: string[], expected: string): number {
  const want = expected.trim().toLowerCase();
  if (!want) return -1;
  const wantBare = stripCode(expected).toLowerCase();
  const tiers: ((label: string) => boolean)[] = [
    (l) => l.trim().toLowerCase() === want,
    (l) => stripCode(l).toLowerCase() === wantBare,
    (l) => stripCode(l).toLowerCase().includes(wantBare),
  ];
  for (const test of tiers) {
    const hits = labels.flatMap((label, index) => (test(label) ? [index] : []));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return -1;
  }
  return -1;
}

/** Primary query, then trimmed deduped alternatives (`|` separated), then a shortened primary (first word). */
export function queryPlan(primary: string, altsRaw = ""): string[] {
  const seen = new Set<string>();
  const plan: string[] = [];
  const add = (value: string) => {
    const text = value.trim();
    if (text && !seen.has(text.toLowerCase())) {
      seen.add(text.toLowerCase());
      plan.push(text);
    }
  };
  add(primary);
  for (const alt of altsRaw.split("|")) add(alt);
  add(primary.trim().split(/\s+/)[0] ?? "");
  return plan;
}

/** Lookup wait limit: NZWH_LOOKUP_TIMEOUT_SECONDS (5-180, default 45). */
export function lookupTimeoutMs(): number {
  const raw = Number(process.env.NZWH_LOOKUP_TIMEOUT_SECONDS);
  return (Number.isInteger(raw) && raw >= 5 && raw <= 180 ? raw : 45) * 1000;
}
