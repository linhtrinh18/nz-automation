import { describe, expect, test } from "vitest";
import { findCountry, matchTile } from "./countries";
const tiles = [
  { text: "JAPAN", href: "/WorkingHoliday/Application/Create.aspx?CountryId=230&OffShore=1&STZ=0", open: true },
  { text: "VIETNAM", href: null, open: false },
];
describe("country tiles", () => {
  test("matches by href CountryId", () => {
    expect(matchTile(tiles, { name: "X", countryId: 230 })?.text).toBe("JAPAN");
  });
  test("matches text case-insensitively", () => {
    expect(matchTile(tiles, { name: "japan" })?.open).toBe(true);
  });
  test("returns closed tiles with open false", () => {
    expect(matchTile(tiles, findCountry("vietnam")!)?.open).toBe(false);
  });
  test("returns undefined when absent", () => {
    expect(matchTile(tiles, { name: "FRANCE" })).toBeUndefined();
  });
});
