const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 60 * 60 * 1000],
	["month", 30 * 24 * 60 * 60 * 1000],
	["week", 7 * 24 * 60 * 60 * 1000],
	["day", 24 * 60 * 60 * 1000],
	["hour", 60 * 60 * 1000],
	["minute", 60 * 1000],
];

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 days ago", "yesterday", "just now". */
export function formatRelative(time: number, now = Date.now()): string {
	const elapsed = time - now;
	for (const [unit, size] of UNITS) {
		if (Math.abs(elapsed) >= size) return relative.format(Math.round(elapsed / size), unit);
	}
	return "just now";
}

const short = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const long = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "Oct 27". */
export function formatShortDate(time: number): string {
	return short.format(time);
}

/** "Oct 27, 2026, 5:31 PM", for tooltips. */
export function formatDateTime(time: number): string {
	return long.format(time);
}

/** "Fri, Oct 30, 9:00 AM Europe/Istanbul": the time as a clock in that time zone reads it. */
export function formatInZone(time: number, timeZone: string): string {
	const clock = new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone,
	});
	return `${clock.format(time)} ${timeZone}`;
}
