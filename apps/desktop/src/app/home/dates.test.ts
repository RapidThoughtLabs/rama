// Run with `bun test apps/desktop/src/app/home`. TZ is pinned before any Date is built so the DST
// case is a real 23-hour day (Europe/Lisbon springs forward on 29 March 2026).
process.env.TZ = "Europe/Lisbon";

import { describe, expect, test } from "bun:test";
import { calendarDaysAgo, dateGroupLabel, greeting, groupByDate, relativeTime } from "./dates";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 5, 18, 30); // the mockup's clock

describe("dateGroupLabel", () => {
  test("today, yesterday, previous 7 days", () => {
    expect(dateGroupLabel(at(2026, 10, 5, 0, 0), NOW)).toBe("Today");
    expect(dateGroupLabel(at(2026, 10, 4, 23, 59), NOW)).toBe("Yesterday");
    expect(dateGroupLabel(at(2026, 10, 3), NOW)).toBe("Previous 7 days");
    expect(dateGroupLabel(at(2026, 9, 28, 0, 1), NOW)).toBe("Previous 7 days");
    expect(dateGroupLabel(at(2026, 9, 27, 23, 59), NOW)).toBe("September");
  });

  test("midnight boundary: one minute past midnight is a new day", () => {
    const justAfter = at(2026, 10, 6, 0, 1);
    expect(dateGroupLabel(at(2026, 10, 5, 23, 59), justAfter)).toBe("Yesterday");
    expect(dateGroupLabel(at(2026, 10, 6, 0, 0), justAfter)).toBe("Today");
  });

  test("month rollover: 1 October still counts last week as previous 7 days", () => {
    const oct1 = at(2026, 10, 1, 9);
    expect(dateGroupLabel(at(2026, 9, 30), oct1)).toBe("Yesterday");
    expect(dateGroupLabel(at(2026, 9, 24), oct1)).toBe("Previous 7 days");
    expect(dateGroupLabel(at(2026, 9, 23), oct1)).toBe("September");
  });

  test("year boundary: an earlier year carries the year", () => {
    const jan2 = at(2027, 1, 2, 10);
    expect(dateGroupLabel(at(2026, 12, 31), jan2)).toBe("Previous 7 days");
    expect(dateGroupLabel(at(2026, 12, 1), jan2)).toBe("December 2026");
    expect(dateGroupLabel(at(2026, 9, 1), NOW)).toBe("September");
  });

  test("DST: the 23-hour spring-forward day still counts as one day", () => {
    const after = at(2026, 3, 30, 0, 30); // just after midnight on the day after the change
    expect(calendarDaysAgo(at(2026, 3, 29, 0, 30), after)).toBe(1);
    expect(calendarDaysAgo(at(2026, 3, 28, 23, 30), after)).toBe(2);
    expect(dateGroupLabel(at(2026, 3, 29, 23, 0), after)).toBe("Yesterday");
  });

  test("a clock-skewed future timestamp is today", () => {
    expect(dateGroupLabel(NOW + 3_600_000, NOW)).toBe("Today");
  });
});

describe("groupByDate", () => {
  test("orders groups and rows newest first", () => {
    const chats = [
      { id: "old", updatedAt: at(2026, 9, 14) },
      { id: "a", updatedAt: at(2026, 10, 5, 9) },
      { id: "b", updatedAt: at(2026, 10, 5, 16) },
      { id: "y", updatedAt: at(2026, 10, 4) },
    ];
    const groups = groupByDate(chats, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "September"]);
    expect(groups[0]!.items.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("relativeTime", () => {
  test("the mockup's strings", () => {
    expect(relativeTime(at(2026, 10, 5, 16, 30), NOW)).toBe("2 hours ago");
    expect(relativeTime(at(2026, 10, 5, 13, 30), NOW)).toBe("5 hours ago");
    expect(relativeTime(at(2026, 10, 5, 9, 10), NOW)).toBe("This morning");
  });

  test("minutes, hours and the rest of the ladder", () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe("Just now");
    expect(relativeTime(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe("59 minutes ago");
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe("1 hour ago");
    expect(relativeTime(at(2026, 10, 5, 12, 0), NOW)).toBe("This afternoon");
    expect(relativeTime(at(2026, 10, 5, 23, 0), at(2026, 10, 5, 23, 59))).toBe("59 minutes ago");
    expect(relativeTime(at(2026, 10, 5, 17, 10), at(2026, 10, 5, 23, 30))).toBe("This evening");
    expect(relativeTime(at(2026, 10, 4, 22), NOW)).toBe("Yesterday");
    expect(relativeTime(at(2026, 10, 3), NOW)).toBe("Saturday");
    expect(relativeTime(at(2026, 9, 29), NOW)).toBe("Tuesday");
    expect(relativeTime(at(2026, 9, 28), NOW)).toBe("28 Sep");
    expect(relativeTime(at(2025, 9, 12), NOW)).toBe("12 Sep 2025");
  });

  test("a future timestamp reads as just now", () => {
    expect(relativeTime(NOW + 90_000, NOW)).toBe("Just now");
  });
});

describe("greeting", () => {
  test("by the hour", () => {
    expect(greeting(0)).toBe("Up late, aren't we");
    expect(greeting(4)).toBe("Up late, aren't we");
    expect(greeting(5)).toBe("Good morning");
    expect(greeting(12)).toBe("Good afternoon");
    expect(greeting(17)).toBe("Good evening");
    expect(greeting(18)).toBe("Good evening");
  });
});
