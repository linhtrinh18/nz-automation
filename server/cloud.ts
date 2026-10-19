import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { registerLogSecret } from "../lib/log-stamp";
import { blankApplication } from "../workflow/application-data";
export type CredentialBinding = { userId: string; revision: string };
export class DocumentError extends Error { constructor(message: string, public status = 400) { super(message); } }
export class CredentialError extends Error {}
export const bindingSchema = z.object({ userId: z.string().min(1), revision: z.string().uuid() }).strict();
const statusSchema = z.object({ userId: z.string().min(1), binding: bindingSchema.nullable(), credentialsConfigured: z.boolean(), capsolverConfigured: z.boolean(), capsolverAvailable: z.boolean(), twoCaptchaConfigured: z.boolean(), twoCaptchaAvailable: z.boolean(), autocaptchaConfigured: z.boolean().default(false), autocaptchaAvailable: z.boolean().default(false), applicationId: z.string() });
type Context = { authorization: string; appOrigin: string; binding?: CredentialBinding; applicationId?: string };
export const cloudContext = new AsyncLocalStorage<Context>();
let workerContext: Context | undefined;
export function parseAppOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.origin !== raw || !["http:", "https:"].includes(url.protocol)) throw new Error("A valid frontend Origin header is required.");
  return raw;
}
export function currentAppOrigin(): string { return context().appOrigin; }
function context(): Context {
  const value = cloudContext.getStore() ?? workerContext;
  if (!value) throw new CredentialError("Authenticated execution context is missing.");
  return value;
}
export function currentAuthorization(): string { return context().authorization; }
export function applicationId(): string { return (cloudContext.getStore() ?? workerContext)?.applicationId ?? process.env.NZWH_APPLICATION_ID ?? ""; }
export function setWorkerAuthorization(authorization: string, appOrigin: string): void {
  if (!/^Bearer \S+$/i.test(authorization)) throw new CredentialError("Missing execution session.");
  workerContext = { authorization, appOrigin: parseAppOrigin(appOrigin) };
}
export async function cloudCall(operation: string, extra: object = {}, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${currentAppOrigin()}/api/automation/context`, {
    method: "POST", redirect: "error", headers: { Authorization: currentAuthorization(), "Content-Type": "application/json" },
    body: JSON.stringify({ operation, ...extra }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(7000)]) : AbortSignal.timeout(7000), cache: "no-store",
  });
  if (!response.ok) throw new CredentialError("Execution authorization or configuration is unavailable. Check the app and review a new plan.");
  return response.json();
}
export async function executionStatus() { return statusSchema.parse(await cloudCall("status")); }
async function result(operation: string, extra: object, signal?: AbortSignal): Promise<unknown> {
  return z.object({ result: z.unknown() }).parse(await cloudCall(operation, extra, signal)).result;
}
export async function assertCurrentCredentials(binding: CredentialBinding): Promise<void> {
  await result("validate", { binding });
  context().binding = binding;
}
export async function loadRunCredentials(binding: CredentialBinding) {
  const credentials = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(await result("credentials", { binding }));
  registerLogSecret(credentials.username); registerLogSecret(credentials.password);
  return credentials;
}
export async function loadRunPayerName(binding: CredentialBinding): Promise<string> { return z.string().parse(await result("payer", { binding })); }
export async function loadDocumentForRun(userId: string, documentId: string, revision: string) {
  const binding = context().binding;
  if (!binding || binding.userId !== userId) throw new DocumentError("Invalid document owner.", 403);
  const document = await result("document", { binding, input: { data: blankApplication(), source: { kind: "document", documentId, revision } } });
  return z.object({ id: z.string().uuid(), revision: z.string().uuid(), name: z.string(), data: (await import("../workflow/application-data")).applicationDataSchema }).parse(document);
}
export async function loadCapSolverKey(signal?: AbortSignal, provider: "capsolver" | "twoCaptcha" | "autoCaptcha" = "capsolver"): Promise<string | null> {
  const binding = context().binding;
  if (!binding) throw new CredentialError("Missing credential binding.");
  const key = z.string().min(1).nullable().parse(await result("provider", { binding, provider }, signal));
  if (key) registerLogSecret(key);
  return key;
}
export function loadTwoCaptchaKey(signal?: AbortSignal) { return loadCapSolverKey(signal, "twoCaptcha"); }
export function loadAutoCaptchaKey(signal?: AbortSignal) { return loadCapSolverKey(signal, "autoCaptcha"); }
