// Local 127.0.0.1 fixture for the Personal3 occupation widget (full-page POST postbacks with a configurable delay).
import { createServer, type Server } from "node:http";

const IND = "ContentPlaceHolder1_generalPersonal_industryControl_";
const OCC = "ContentPlaceHolder1_generalPersonal_occupationControl_";
export const INDUSTRY_TARGET = "L783400 Computer Consultancy Services";
export const OCCUPATION_TARGET = "Software Engineer";

export interface Scenario {
  /** Result labels for a control ("industry" | "occupation"), the typed query and whether the full list was requested. */
  results(control: "industry" | "occupation", query: string, fullList: boolean): string[];
  /** Delay (ms) of each postback per control. */
  delay(control: "industry" | "occupation"): number;
  preselected?: { industry?: string; occupation?: string };
  fullListLink?: boolean;
}

export interface Fixture {
  base: string;
  searchPosts: number;
  close(): Promise<void>;
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export async function startFixture(scenario: Scenario): Promise<Fixture> {
  const state = {
    industry: { query: "", selected: scenario.preselected?.industry ?? "", results: [] as string[] },
    occupation: { query: "", selected: scenario.preselected?.occupation ?? "", results: [] as string[] },
  };
  const fixture = { searchPosts: 0 } as Fixture;
  const control = (name: "industry" | "occupation", prefix: string, label: string) => `
    <fieldset><legend>${name}</legend>
      <input type="text" id="${prefix}optionListSearch_SearchStringTextBox" name="${name}Q" value="${esc(state[name].query)}">
      <input type="submit" id="${prefix}optionListSearch_SearchImageButton" name="${name}Search" value="Search">
      ${scenario.fullListLink === false ? "" : `<a id="${prefix}fullListLink" href="/WorkingHoliday/Wizard/Personal3.aspx?full=${name}">Show the full list</a>`}
      <div>${state[name].results.map((r, i) => `<input type="submit" id="${prefix}optionListSearch_SearchResultRepeater_optionDescriptionButton_${i}" name="${name}Pick" value="${esc(r)}">`).join("")}</div>
      <p>Selected Value: <span id="${prefix}${label}">${esc(state[name].selected)}</span></p>
    </fieldset>`;
  const page = () => `<!doctype html><meta charset="utf-8"><title>Personal3 fixture</title>
    <form method="post" action="/WorkingHoliday/Wizard/Personal3.aspx">
    ${control("industry", IND, "selectedIndustryLabel")}${control("occupation", OCC, "selectedOccupationLabel")}</form>`;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const reply = (ms: number) => setTimeout(() => { res.setHeader("content-type", "text/html"); res.end(page()); }, ms);
    if (req.method !== "POST") {
      const full = url.searchParams.get("full") as "industry" | "occupation" | null;
      if (full) state[full].results = scenario.results(full, state[full].query, true);
      return void reply(full ? scenario.delay(full) : 0);
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      state.industry.query = form.get("industryQ") ?? "";
      state.occupation.query = form.get("occupationQ") ?? "";
      for (const name of ["industry", "occupation"] as const) {
        if (form.has(`${name}Search`)) {
          fixture.searchPosts++;
          state[name].results = scenario.results(name, state[name].query, false);
          return void reply(scenario.delay(name));
        }
        const pick = form.get(`${name}Pick`);
        if (pick !== null) {
          state[name].selected = pick;
          state[name].results = [];
          return void reply(scenario.delay(name));
        }
      }
      reply(0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fixture.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fixture.close = () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  return fixture;
}

export const target = (result: string[]) => ({ industry: [...result, INDUSTRY_TARGET], occupation: [...result, OCCUPATION_TARGET] });
export function pick(control: "industry" | "occupation", extra: string[] = []): string[] {
  return [...extra, control === "industry" ? INDUSTRY_TARGET : OCCUPATION_TARGET];
}
