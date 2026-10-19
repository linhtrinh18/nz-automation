import { expect, test } from "vitest";
import { formatClock, formatDuration } from "./format-duration";
test("formats friendly durations", () => {
  expect(formatDuration(0)).toBe("0.1s");
  expect(formatDuration(12_400)).toBe("12.4s");
  expect(formatDuration(59_999)).toBe("1m 00s");
  expect(formatDuration(65_000)).toBe("1m 05s");
  expect(formatDuration(3_725_000)).toBe("1h 02m 05s");
  expect(formatDuration(-5000)).toBe("0.1s");
  expect(formatDuration(Number.NaN)).toBe("0.1s");
});
test("formats clock", () => {
  expect(formatClock(0)).toBe("00:00");
  expect(formatClock(59_999)).toBe("00:59");
  expect(formatClock(3_600_000)).toBe("01:00:00");
  expect(formatClock(Number.NaN)).toBe("00:00");
});
