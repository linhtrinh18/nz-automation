/**
 * Countries selectable on the Working Holiday tile grid.
 * To add one: append { code, name (tile text on the site), label (UI text) }.
 * countryId (the CountryId query value) is optional; set it only once verified.
 */
export const countries = [
  { code: "vietnam", name: "VIETNAM", label: "Việt Nam" },
  { code: "japan", name: "JAPAN", label: "Nhật Bản" },
] as const satisfies readonly {
  code: string;
  name: string;
  label: string;
  countryId?: number;
}[];
export type CountryCode = (typeof countries)[number]["code"];
export type Country = {
  code: string;
  name: string;
  label: string;
  countryId?: number;
};
export const countryCodes = countries.map((c) => c.code) as [
  CountryCode,
  ...CountryCode[],
];
export function findCountry(code: string): Country | undefined {
  return (countries as readonly Country[]).find((c) => c.code === code);
}
export interface CountryTile {
  text: string;
  href: string | null;
  open: boolean;
}
/** Match by CountryId in href first, then by case-insensitive tile text. */
export function matchTile(
  tiles: CountryTile[],
  country: Pick<Country, "name" | "countryId">,
): CountryTile | undefined {
  if (country.countryId !== undefined) {
    const byHref = tiles.find((t) => {
      if (!t.href) return false;
      try {
        return (
          new URL(t.href, "https://x.invalid").searchParams.get("CountryId") ===
          String(country.countryId)
        );
      } catch {
        return false;
      }
    });
    if (byHref) return byHref;
  }
  const name = country.name.trim().toLowerCase();
  return tiles.find((t) => t.text.trim().toLowerCase() === name);
}
