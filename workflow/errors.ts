/** Curated messages may be shown in the local UI; never include applicant values. */
export class WorkingHolidayStop extends Error {}

/** Reload succeeded on the pinned section, but some saved fields differ. */
export class SavedValueVerificationError extends WorkingHolidayStop {
  constructor(public readonly fields: string[], public readonly checked: number) {
    super(`Saved-value verification failed: ${fields.join(", ")}.`);
    this.name = "SavedValueVerificationError";
  }
}

/** A postback timed out; never replay it automatically. */
export class SectionPostbackTimeoutError extends WorkingHolidayStop {
  constructor(section: string) {
    super(`Postback timed out in ${section}; save state is unverified.`);
    this.name = "SectionPostbackTimeoutError";
  }
}
