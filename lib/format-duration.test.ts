import { expect, test } from "vitest";
import { formatDuration } from "./format-duration";

test("formats durations", () => {
  expect(formatDuration(0)).toBe("00:00");
  expect(formatDuration(59_999)).toBe("00:59");
  expect(formatDuration(60_000)).toBe("01:00");
  expect(formatDuration(3_599_000)).toBe("59:59");
  expect(formatDuration(3_600_000)).toBe("01:00:00");
  expect(formatDuration(-5000)).toBe("00:00");
  expect(formatDuration(Number.NaN)).toBe("00:00");
});
