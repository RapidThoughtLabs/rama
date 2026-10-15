/* Home's date words — HOME_REDESIGN_PLAN.md Phases HD4 (sidebar groups) and HD5 (the resume rows'
   times and the landing greeting). Everything is local time and calendar days, never 24-hour
   buckets, so a DST day or a late-night chat lands in the group a person would expect. English
   only, with fixed month/weekday names, so output doesn't drift with the WebView's locale. */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole calendar days between `ts` and `now` (0 = same day). Rounding absorbs 23h/25h DST days. */
export function calendarDaysAgo(ts: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
}

/** The sidebar group a chat last touched at `ts` belongs to (mock:L1517-1522). */
export function dateGroupLabel(ts: number, now: number): string {
  const days = calendarDaysAgo(ts, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  const d = new Date(ts);
  const month = MONTHS[d.getMonth()]!;
  return d.getFullYear() === new Date(now).getFullYear() ? month : `${month} ${d.getFullYear()}`;
}

export interface DateGroup<T> {
  label: string;
  items: T[];
}

/** Newest first, rows within a group by `updatedAt` descending. Labels only ever get older as
 *  `updatedAt` falls, so grouping consecutive runs after the sort is enough. */
export function groupByDate<T extends { updatedAt: number }>(items: readonly T[], now: number): DateGroup<T>[] {
  const groups: DateGroup<T>[] = [];
  for (const item of [...items].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const label = dateGroupLabel(item.updatedAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** The resume rows' time (mock:L882-904: "2 hours ago", "This morning"). */
export function relativeTime(ts: number, now: number): string {
  const mins = Math.floor((now - ts) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return mins === 1 ? "1 minute ago" : `${mins} minutes ago`;
  const days = calendarDaysAgo(ts, now);
  const d = new Date(ts);
  if (days <= 0) {
    const hours = Math.floor(mins / 60);
    if (hours < 6) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
    const h = d.getHours();
    return h < 12 ? "This morning" : h < 17 ? "This afternoon" : "This evening";
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAYS[d.getDay()]!;
  const short = `${d.getDate()} ${MONTHS[d.getMonth()]!.slice(0, 3)}`;
  return d.getFullYear() === new Date(now).getFullYear() ? short : `${short} ${d.getFullYear()}`;
}

/** The landing greeting (mock:L1593-1598). */
export function greeting(hour: number): string {
  if (hour < 5) return "Up late, aren't we";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}
