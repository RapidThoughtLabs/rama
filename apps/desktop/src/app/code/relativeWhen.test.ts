// Run with `bun test apps/desktop/src/app/code`. TZ is pinned before any Date is built.
process.env.TZ = "Europe/Lisbon";

import { describe, expect, test } from "bun:test";
import { relativeWhen } from "./relativeWhen";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 5, 18, 30); // the mockup's clock

describe("relativeWhen", () => {
  test("under two minutes is Just now, then minutes", () => {
    expect(relativeWhen(NOW - 20_000, NOW)).toBe("Just now");
    expect(relativeWhen(NOW - 119_000, NOW)).toBe("Just now");
    expect(relativeWhen(NOW - 2 * 60_000, NOW)).toBe("2 minutes ago");
    expect(relativeWhen(NOW - 59 * 60_000, NOW)).toBe("59 minutes ago");
  });

  test("the rest of today is Earlier today", () => {
    expect(relativeWhen(NOW - 60 * 60_000, NOW)).toBe("Earlier today"); // the mockup's 4 hours ago too
    expect(relativeWhen(NOW - 4 * 3_600_000, NOW)).toBe("Earlier today");
    expect(relativeWhen(at(2026, 10, 5, 0, 5), NOW)).toBe("Earlier today");
  });

  test("calendar days, not 24-hour buckets", () => {
    expect(relativeWhen(at(2026, 10, 4, 23, 50), at(2026, 10, 5, 0, 10))).toBe("20 minutes ago"); // minutes win while they are under an hour
    expect(relativeWhen(at(2026, 10, 4, 23, 50), at(2026, 10, 5, 2, 10))).toBe("Yesterday");
    expect(relativeWhen(at(2026, 10, 4, 7), NOW)).toBe("Yesterday");
    expect(relativeWhen(at(2026, 10, 3, 7), NOW)).toBe("2 days ago");
  });

  test("the mockup's day counts", () => {
    expect(relativeWhen(NOW - 9 * 86_400_000, NOW)).toBe("9 days ago");
    expect(relativeWhen(NOW - 19 * 86_400_000, NOW)).toBe("19 days ago");
    expect(relativeWhen(NOW - 25 * 86_400_000 - 3_600_000, NOW)).toBe("25 days ago");
  });

  test("a day count across the spring-forward day is still whole days", () => {
    expect(relativeWhen(at(2026, 3, 28, 12), at(2026, 3, 30, 12))).toBe("2 days ago");
  });

  test("past 60 days it is a date, with the year only when it differs", () => {
    expect(relativeWhen(at(2026, 6, 3), NOW)).toBe("3 Jun");
    expect(relativeWhen(at(2025, 12, 24), NOW)).toBe("24 Dec 2025");
  });
});
