// The one-time code in a sign-up or sign-in message, for an agent that should read nothing else of
// it. Mail is how a stranger reaches an agent, so `get_verification_code` hands over this and the
// sender's domain, never the text around it. It answers null rather than guess.
//
// Every pattern here runs in time linear in the text: a stranger writes it, and a pattern that
// backtracks would let one message spend the Worker's CPU on every look.

/** Words a code follows: "Your code is 482913", "OTP: 482913". */
const NAMES = /\b(?:codes?|otp|passcode|pin|token|one[- ]?time password)\b/gi;

/**
 * Words that put a code near without naming it, as in "Verify with 482913" or "Use 482913 to sign
 * in". One counts only on a line that names no code, and only right beside the code, as on its own
 * the word says too little: "Confirm your order 4521".
 */
const HINTS = /\b(?:verification|verify|confirm(?:ation)?|log ?in|sign[- ]?in|security|2fa)\b/gi;

/** How close to a hint a code must be, in characters between them. */
const HINT_REACH = 8;

/**
 * Two groups of three digits, or four to ten digits, standing alone: not part of a word, an
 * amount, a number with a point or comma, or a longer run of groups such as a phone number. A
 * sentence may end after it.
 */
const DIGITS = /(?<![\w.,/:@+$€£¥#-]|\d )(\d{3}[ -]\d{3}|\d{4,10})(?![\w,/:@%-]|\.\d| \d)/g;

/**
 * Capitals and digits with at least one of each, standing alone: five to ten together, or two
 * groups of three to five joined by a dash, as Slack's "XKD-4PQ".
 */
const MIXED =
	/(?<![\w.,/:@+#-])(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])(?:[A-Z0-9]{3,5}-[A-Z0-9]{3,5}|[A-Z0-9]{5,10})(?![\w,/:@-]|\.\w)/g;

/** A year near now reads as a date, not a code. */
const YEAR = /^(?:19|20)\d\d$/;

/** The most of a message looked at, and of one line: codes come early, on short lines. */
const MAX_TEXT = 50_000;
const MAX_LINE = 2_000;

interface Candidate {
	code: string;
	/** Where it starts in its line. */
	at: number;
}

/**
 * A line with its links and addresses blanked out, as they hold digits that are no code. Each
 * becomes spaces of its own length, so the places of what is left hold.
 */
function withoutNoise(line: string): string {
	return line.replace(/\S+/g, (token) =>
		token.includes("@") || /^\W*(?:https?:\/\/|www\.)/i.test(token)
			? " ".repeat(token.length)
			: token,
	);
}

/** What in a line could be a code, in the order they come. */
function candidates(line: string): Candidate[] {
	const clean = withoutNoise(line);
	const digits = [...clean.matchAll(DIGITS)].map((match) => ({
		code: (match[1] ?? "").replace(/[ -]/g, ""),
		at: match.index,
	}));
	const mixed = [...clean.matchAll(MIXED)].map((match) => ({ code: match[0], at: match.index }));
	return [...digits, ...mixed]
		.filter((candidate) => !YEAR.test(candidate.code))
		.sort((a, b) => a.at - b.at);
}

/** Where each match of a word list starts and ends in a line. */
const spansOf = (line: string, words: RegExp) =>
	[...line.matchAll(words)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));

/**
 * The code a line gives: the first after the last word that names one ("code", "OTP") with one
 * after it, or the one that starts the line when such a word comes later, as in "482913 is your
 * code"; on a line that names none, one right beside a hint ("verify"). Null otherwise.
 */
function codeInLine(line: string): string | null {
	const found = candidates(line);
	if (found.length === 0) return null;
	const named = spansOf(line, NAMES);
	if (named.length > 0) {
		for (const { end } of named.toReversed()) {
			const after = found.find((candidate) => candidate.at >= end);
			if (after) return after.code;
		}
		const [first] = found;
		return first && line.slice(0, first.at).trim() === "" ? first.code : null;
	}
	for (const hint of spansOf(line, HINTS)) {
		const beside = found.find(
			(candidate) =>
				(candidate.at >= hint.end && candidate.at - hint.end <= HINT_REACH) ||
				(candidate.at < hint.start &&
					hint.start - (candidate.at + candidate.code.length) <= HINT_REACH),
		);
		if (beside) return beside.code;
	}
	return null;
}

/** Whether a line says it is about a code, or near one. */
const speaksOfCode = (line: string) =>
	spansOf(line, NAMES).length > 0 || spansOf(line, HINTS).length > 0;

/** The code a line holds and nothing else, as one set apart under "Your code:". */
function codeAlone(line: string): string | null {
	const found = candidates(line);
	const [only] = found;
	if (!only || found.length > 1) return null;
	const plain = (text: string) => text.replace(/[^A-Za-z0-9]/g, "");
	return plain(line) === plain(only.code) ? only.code : null;
}

/**
 * The code a message carries: in its subject, beside a word that names it; else in its text, on
 * a line that speaks of it or set apart in the lines after; else the one line that is a code alone.
 * Null when none of these finds one.
 */
export function findVerificationCode(subject: string, text: string): string | null {
	const inSubject = codeInLine(subject.slice(0, MAX_LINE));
	if (inSubject) return inSubject;
	const lines = text
		.slice(0, MAX_TEXT)
		.split(/\r?\n/)
		.map((line) => line.slice(0, MAX_LINE).trim());
	for (const [at, line] of lines.entries()) {
		if (!speaksOfCode(line)) continue;
		const here = codeInLine(line);
		if (here) return here;
		const next = lines
			.slice(at + 1, at + 6)
			.filter(Boolean)
			.slice(0, 2);
		for (const near of next) {
			const alone = codeAlone(near);
			if (alone) return alone;
		}
	}
	const alone = [...new Set(lines.map(codeAlone).filter((code) => code !== null))];
	return alone.length === 1 ? (alone[0] ?? null) : null;
}

/**
 * A line, such as a subject, with the code it gives blanked out, and with it whatever else in it
 * could be one, as an agent's log keeps a subject but never a code. The line as it is when it
 * gives none.
 */
export function withoutCode(line: string): string {
	if (!codeInLine(line.slice(0, MAX_LINE))) return line;
	const clean = withoutNoise(line);
	const spans = [...clean.matchAll(DIGITS), ...clean.matchAll(MIXED)]
		.filter((match) => !YEAR.test(match[0].replace(/[ -]/g, "")))
		.map((match) => ({ start: match.index, end: match.index + match[0].length }))
		.sort((one, other) => one.start - other.start);
	let kept = "";
	let from = 0;
	for (const { start, end } of spans) {
		if (start < from) continue;
		kept += `${line.slice(from, start)}•••`;
		from = end;
	}
	return kept + line.slice(from);
}
