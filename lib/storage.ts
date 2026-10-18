import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationDataSchema,
  blankApplication,
} from "../workflow/application-data";
import type { ApplicationData } from "../workflow/application-data";

// Legacy/standalone file helpers only. HTTP routes and app runs must use owner-scoped
// database documents. Existing files are never auto-published or assigned to a user.
export type DataSource = "applicant" | "sample";
export function dataDir(): string {
  return process.env.NZWH_DATA_DIR ?? join(process.cwd(), "data");
}
export async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Invalid data file.");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
export async function readApplicant(): Promise<ApplicationData> {
  try {
    return applicationDataSchema.parse(
      await readJson(join(dataDir(), "applicant.json")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return blankApplication();
    throw error;
  }
}
export async function readSample(): Promise<ApplicationData> {
  return applicationDataSchema.parse(
    await readJson(join(dataDir(), "sample.json")),
  );
}
export async function readSource(source: DataSource): Promise<ApplicationData> {
  return source === "sample" ? readSample() : readApplicant();
}
let saves = Promise.resolve();
export async function saveSource(
  source: DataSource,
  input: unknown,
): Promise<ApplicationData> {
  if (source !== "sample" && source !== "applicant") throw new Error("Unknown legacy data source.");
  // Only these two whitelisted filenames can ever be written.
  const file = source === "sample" ? "sample.json" : "applicant.json";
  const data = applicationDataSchema.parse(input);
  let release = () => {};
  const previous = saves;
  saves = new Promise<void>((done) => {
    release = done;
  });
  await previous;
  let temporary: string | undefined;
  try {
    const directory = dataDir();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    temporary = join(directory, `.saving-${randomUUID()}`);
    const handle = await open(
      /*turbopackIgnore: true*/ temporary,
      "wx",
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const target = join(/*turbopackIgnore: true*/ directory, file);
    await rename(/*turbopackIgnore: true*/ temporary, /*turbopackIgnore: true*/ target);
    temporary = undefined;
    return data;
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    release();
  }
}
export const saveApplicant = (input: unknown) => saveSource("applicant", input);
export const saveSample = (input: unknown) => saveSource("sample", input);
