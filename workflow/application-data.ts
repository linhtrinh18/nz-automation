import { z } from "zod";

import { steps, occupationLookups } from "./fields";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]));
const valuesSchema = z.record(z.string().max(250));
const dataShapeSchema = z.object({
  dataKind: z.enum(["fictional", "applicant"]),
  personal: valuesSchema, identification: valuesSchema, occupation: valuesSchema,
  health: valuesSchema, character: valuesSchema, adviser: valuesSchema, workingHoliday: valuesSchema,
  scenarios: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), changes: z.record(valuesSchema), notes: z.string() }).catchall(jsonValue)).default([]),
}).catchall(jsonValue);
export type ApplicationData = z.infer<typeof dataShapeSchema> & JsonObject;
export const applicationDataSchema = dataShapeSchema.transform(data => data as ApplicationData);
export type SectionName = "personal" | "identification" | "occupation" | "health" | "character" | "adviser" | "workingHoliday";
export const sectionNames = Object.keys(steps) as SectionName[];

export function blankApplication(): ApplicationData {
  const sections = Object.fromEntries(sectionNames.map(name => [name, Object.fromEntries([
    ...Object.keys(steps[name].fields), ...(name === "occupation" ? occupationLookups.flatMap(item => [item.resultKey, item.altQueryKey]) : []),
  ].map(key => [key, ""]))]));
  return applicationDataSchema.parse({ dataKind: "applicant", ...sections });
}
