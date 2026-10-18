import { applicationId } from "../server/cloud";
import { createHash } from "node:crypto";
/** Bind live recovery/review to this account and configured application without storing credentials. */
export function targetFingerprint(binding?: { userId: string; revision: string }): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        account: binding ?? process.env.NZWH_USERNAME ?? "",
        application: applicationId(),
        site: "https://onlineservices.immigration.govt.nz",
      }),
    )
    .digest("hex");
}
