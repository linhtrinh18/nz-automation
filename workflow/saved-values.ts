/** The live Medical1.aspx save strips colons from health details (verified in Chrome).
 * Prepare that field before entry so readback and persistence both remain exact.
 */
export function expectedFieldValue(section: string, key: string, value: string): string {
  return section === "health" && key === "details" ? value.replace(/:/g, "") : value;
}

/** Diagnostic metadata only: never return applicant text. */
export function savedValueDiagnostic(expected: string, actual: string | null): string {
  const normalizeLines = (value: string) => value.replace(/\r\n?/g, "\n");
  const difference = actual === null ? "missing-value"
    : actual === "" && expected !== "" ? "cleared"
    : normalizeLines(expected) === normalizeLines(actual) ? "line-endings"
    : expected.trim() === actual.trim() ? "outer-whitespace"
    : expected.replace(/:/g, "") === actual ? "colons-removed"
    : "content-changed";
  return `expectedLength=${expected.length} actualLength=${actual?.length ?? "null"} difference=${difference}`;
}
