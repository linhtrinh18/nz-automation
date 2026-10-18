/** Occupation automation is disabled at the user's request. */
export function automatedSection(section: string): boolean {
  return section !== "occupation";
}
