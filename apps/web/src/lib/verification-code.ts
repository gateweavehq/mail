// The one-time code in a sign-up or sign-in message, for an agent that should read nothing else of
// it. Mail is how a stranger reaches an agent, so `get_verification_code` hands over this and who
// sent it, never the text around it. It answers null rather than guess.

/** Words that say a code is near. */
const NEAR =
	/\b(code|codes|verification|verify|one[- ]?time|otp|passcode|pin|security|confirm|confirmation|login|log in|sign[- ]?in|token)\b/i;

/**
 * Two groups of three digits, or four to ten digits, standing alone: not part of a word, a number
 * with a point or comma, a link, or a longer run of groups such as a phone number. A sentence may
 * end after it.
 */
const DIGITS = /(?<![\w.,/:@+-]|\d )(\d{3}[ -]\d{3}|\d{4,10})(?![\w,/:@-]|\.\d| \d)/g;

/** Four to ten capitals and digits with at least one of each, standing alone. */
const MIXED = /(?<![\w.,/:@+-])(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,10}(?![\w,/:@-]|\.\w)/g;

/** Links and addresses hold digits that are no code. */
const NOISE = /\bhttps?:\/\/\S+|\bwww\.\S+|\S+@\S+\.\S+/gi;

/** A year near now reads as a date, not a code. */
const YEAR = /^(19|20)\d\d$/;

function candidates(line: string): string[] {
	const clean = line.replace(NOISE, " ");
	const digits = [...clean.matchAll(DIGITS)]
		.map((match) => (match[1] ?? "").replace(/[ -]/g, ""))
		.filter((code) => !YEAR.test(code));
	return digits.length > 0 ? digits : [...clean.matchAll(MIXED)].map((match) => match[0]);
}

/**
 * The code a message carries, from its subject or its text: the first standing near a word such as
 * "code" or "verify", on the same line or the two after it; or else the only one in the message.
 */
export function findVerificationCode(subject: string, text: string): string | null {
	if (NEAR.test(subject)) {
		const [first] = candidates(subject);
		if (first) return first;
	}
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	for (const [at, line] of lines.entries()) {
		if (!NEAR.test(line)) continue;
		const after = lines
			.slice(at, at + 6)
			.filter(Boolean)
			.slice(0, 3);
		for (const near of after) {
			const [first] = candidates(near);
			if (first) return first;
		}
	}
	const every = [...new Set(lines.flatMap(candidates))];
	return every.length === 1 ? (every[0] ?? null) : null;
}
