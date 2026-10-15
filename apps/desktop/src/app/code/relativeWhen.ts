import { calendarDaysAgo } from "../home/dates";

/* The Code landing's "Recent in {project}" times — docs/CODE_REDESIGN_PLAN.md CR8 (mock:L1341-1418:
   "Just now", "Earlier today", "9 days ago"). Calendar days, never 24-hour buckets, like Home's
   dates. "N days ago" runs to 60 days, not the plan's 14, because the mockup's own demo project
   says "25 days ago" (plan §9.36); past that it is a date. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function relativeWhen(ts: number, now: number): string {
  const mins = Math.floor((now - ts) / 60_000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins} minutes ago`;
  const days = calendarDaysAgo(ts, now);
  if (days <= 0) return "Earlier today";
  if (days === 1) return "Yesterday";
  if (days < 60) return `${days} days ago`;
  const d = new Date(ts);
  const short = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? short : `${short} ${d.getFullYear()}`;
}
