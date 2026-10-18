import { describe, expect, it } from "vitest";
import { expectedFieldValue, savedValueDiagnostic } from "./saved-values";

describe("live health save compatibility", () => {
  it("prepares colons only in health details without changing medical words", () => {
    expect(expectedFieldValue("health", "details", "Condition: stable; review: yearly.")).toBe("Condition stable; review yearly.");
    expect(expectedFieldValue("character", "details", "Reason: example")).toBe("Reason: example");
    expect(expectedFieldValue("health", "details", "No changes needed.")).toBe("No changes needed.");
  });
  it("distinguishes cleared, formatting and substantive changes without logging text", () => {
    expect(savedValueDiagnostic("private", "")).toContain("difference=cleared");
    expect(savedValueDiagnostic("a\r\nb", "a\nb")).toContain("difference=line-endings");
    expect(savedValueDiagnostic("Note: private", "Note private")).toContain("difference=colons-removed");
    expect(savedValueDiagnostic("private", "changed")).toBe("expectedLength=7 actualLength=7 difference=content-changed");
  });
});
