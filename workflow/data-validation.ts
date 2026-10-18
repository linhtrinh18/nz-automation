import { automatedSection } from "./section-policy";
import { applicable } from "./conditions";
import { occupationLookups, steps } from "./fields";
import type { ApplicationData, SectionName } from "./application-data";
import { WorkingHolidayStop } from "./errors";

export function scenarioData(
  base: ApplicationData,
  scenario: string,
): ApplicationData {
  const data = structuredClone(base);
  if (scenario === "baseline") return data;
  const match = base.scenarios.find((item) => item.name === scenario);
  if (!match) throw new WorkingHolidayStop("Unknown scenario.");
  for (const [name, changes] of Object.entries(match.changes)) {
    if (!Object.hasOwn(steps, name))
      throw new WorkingHolidayStop("Unsupported scenario section.");
    Object.assign(data[name as SectionName], changes);
  }
  return data;
}

export function validateData(data: ApplicationData): void {
  for (const name of Object.keys(steps)) {
    if (!automatedSection(name)) continue;
    const values = data[name as SectionName];
    const allowed = [
      ...Object.keys(steps[name].fields),
      ...(name === "occupation"
        ? occupationLookups.map((item) => item.resultKey)
        : []),
    ];
    if (allowed.some((key) => !Object.hasOwn(values, key))) {
      throw new WorkingHolidayStop(`Missing mapped fields in ${name}.`);
    }
    for (const [key, field] of Object.entries(steps[name].fields)) {
      if (!applicable(data, name, key)) continue;
      if (field.options && values[key] && !field.options.includes(values[key]))
        throw new WorkingHolidayStop(`Invalid option: ${name}.${key}.`);
      if (
        field.kind === "date" &&
        values[key] &&
        !/^\d{1,2} [A-Z][a-z]+, \d{4}$/.test(values[key])
      )
        throw new WorkingHolidayStop(`Invalid date format: ${name}.${key}.`);
    }
  }
  if (
    data.identification.passportNumber !==
    data.identification.confirmPassportNumber
  )
    throw new WorkingHolidayStop("Passport confirmation differs.");
  if (data.personal.title === "6" && !data.personal.otherTitle)
    throw new WorkingHolidayStop("Other title requires details.");
  if (applicable(data, "health", "details") && !data.health.details)
    throw new WorkingHolidayStop("Medical conditions require details.");
  if (
    data.character.deported === "Yes" &&
    (!data.character.deportedDate || !data.character.deportedCountry)
  )
    throw new WorkingHolidayStop("Deportation requires date and country.");
  if (applicable(data, "character", "details") && !data.character.details)
    throw new WorkingHolidayStop("Character answers require details.");
  if (
    data.workingHoliday.beenToNz === "Yes" &&
    !data.workingHoliday.previousVisitDate
  )
    throw new WorkingHolidayStop("Previous visit requires a date.");
  if (
    applicable(data, "adviser", "exemptionReason") &&
    !data.adviser.exemptionReason
  )
    throw new WorkingHolidayStop(
      "Exempt adviser requires an exemption reason.",
    );
  if (data.adviser.nzbn && !/^94\d{11}$/.test(data.adviser.nzbn))
    throw new WorkingHolidayStop("NZBN must have 13 digits and begin with 94.");
  const birth = Date.parse(data.personal.dateOfBirth);
  const travel = Date.parse(data.workingHoliday.intendedTravel);
  if (
    !Number.isFinite(birth) ||
    !Number.isFinite(travel) ||
    birth >= travel ||
    Date.parse(data.identification.passportExpiry) <= travel
  )
    throw new WorkingHolidayStop(
      "Inconsistent birth, travel or passport expiry dates.",
    );
  if (
    data.workingHoliday.previousVisitDate &&
    Date.parse(data.workingHoliday.previousVisitDate) >= travel
  )
    throw new WorkingHolidayStop(
      "Previous visit must precede intended travel.",
    );
  if (
    data.identification.identificationExpiry &&
    Date.parse(data.identification.identificationExpiry) <=
      Date.parse(data.identification.identificationIssued)
  )
    throw new WorkingHolidayStop(
      "Identification expiry must follow issue date.",
    );
}
