export interface ScenarioSections {
  personal: Record<string, string>;
  identification: Record<string, string>;
  occupation: Record<string, string>;
  health: Record<string, string>;
  character: Record<string, string>;
  adviser: Record<string, string>;
  workingHoliday: Record<string, string>;
}

export function applicable(data: ScenarioSections, section: string, key: string): boolean {
  if (section === "adviser" && key === "exemptionReason") return data.personal.representedByAdviser === "Yes" && data.adviser.adviserType === "2";
  if (section === "adviser") return data.personal.representedByAdviser === "Yes";
  if (section === "personal" && key === "otherTitle") return data.personal.title === "6";
  if (section === "health" && key === "details") return Object.entries(data.health).some(([name, value]) => !["details", "tbRisk"].includes(name) && value === "Yes");
  if (section === "character" && ["deportedDate", "deportedCountry"].includes(key)) return data.character.deported === "Yes";
  if (section === "character" && key === "details") return ["charged", "convicted", "underInvestigation", "excluded", "removed"].some(name => data.character[name] === "Yes");
  if (section === "workingHoliday" && key === "previousVisitDate") return data.workingHoliday.beenToNz === "Yes";
  return true;
}

