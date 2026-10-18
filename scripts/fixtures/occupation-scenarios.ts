// Shared by scripts/verify-occupation-flow.ts (Chrome, real delays) and workflow/occupation-widget.test.ts (short delays).
import type { WebDriver } from "selenium-webdriver";
import { occupationSelectionForTest, setFixtureOriginForTest, withHooksForTest } from "../../workflow/run";
import { blankApplication } from "../../workflow/application-data";
import { INDUSTRY_TARGET, OCCUPATION_TARGET, pick, startFixture, type Scenario } from "./occupation-harness";

export type ScenarioName = "slow" | "fallback" | "fullList" | "alreadySelected" | "noResults";

export function scenarioFor(name: ScenarioName, ms: { industry: number; occupation: number }): { scenario: Scenario; alt: string; query: string } {
  const delay = (c: "industry" | "occupation") => ms[c];
  switch (name) {
    case "slow":
      return { query: "Computer", alt: "", scenario: { delay, results: (c) => pick(c, ["Other Thing"]) } };
    case "fallback":
      return { query: "Zzz", alt: "Alt", scenario: { delay, results: (c, q) => (q === "Alt" ? pick(c) : []) } };
    case "fullList":
      return { query: "Zzz", alt: "", scenario: { delay, results: (c, _q, full) => (full ? pick(c, ["Another"]) : []) } };
    case "alreadySelected":
      return { query: "Computer", alt: "", scenario: { delay, results: () => [], preselected: { industry: "l783400 computer consultancy services", occupation: OCCUPATION_TARGET } } };
    case "noResults":
      return { query: "Zzz", alt: "", scenario: { delay, results: () => [], fullListLink: false } };
  }
}

export interface ScenarioOutcome {
  selected: string[];
  error?: string;
  logs: string[];
  searchPosts: number;
  elapsedMs: number;
  shot?: () => Promise<string>;
}

export async function runScenario(
  driver: WebDriver,
  name: ScenarioName,
  ms: { industry: number; occupation: number },
): Promise<ScenarioOutcome> {
  const { scenario, alt, query } = scenarioFor(name, ms);
  const fixture = await startFixture(scenario);
  setFixtureOriginForTest(fixture.base);
  const data = blankApplication();
  Object.assign(data.occupation, {
    industrySearch: query, occupationSearch: query,
    industryAltQueries: alt, occupationAltQueries: alt,
    industryResult: INDUSTRY_TARGET, occupationResult: OCCUPATION_TARGET,
  });
  await driver.get(`${fixture.base}/WorkingHoliday/Wizard/Personal3.aspx`);
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); original(...args); };
  const started = Date.now();
  const outcome: ScenarioOutcome = { selected: [], logs, searchPosts: 0, elapsedMs: 0 };
  try {
    outcome.selected = await withHooksForTest({ event: async () => undefined, checkpoint: async () => undefined }, () => occupationSelectionForTest(driver, data));
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    console.log = original;
    outcome.elapsedMs = Date.now() - started;
    outcome.searchPosts = fixture.searchPosts;
  }
  outcome.shot = async () => driver.takeScreenshot();
  const shot = outcome.shot;
  outcome.shot = async () => { const png = await shot(); await fixture.close(); return png; };
  return outcome;
}
