/**
 * Email Routing hands each recipient its own copy, so a copy of mail a mailbox already keeps may be
 * the same mail for another of its addresses. The mailbox keeps the one, and this decides what the
 * other adds to it.
 */

/**
 * The longest list of a mailbox's addresses one received message keeps, as copies for more of them
 * arrive: past it, the first ones stay.
 */
export const MAX_ENVELOPE_TO = 2_000;

/**
 * How soon after the kept copy another copy of the same mail must come to count, when its sender
 * isn't proved to have addressed it there (`cameAlso`).
 */
export const COPIES_WITHIN_MS = 60 * 60 * 1000;

/** What `cameAlso` reads of a received message: a type, as a row's must be. */
export type Copy = {
	envelopeTo: string;
	cameFor: string | null;
	verifiedDomain: string | null;
	arrivedAt: number;
	/** 1 when its sender is proved to have addressed it to `envelopeTo` (`Judge`), else 0. */
	addressed: number;
};

/** The addresses an envelope's list names, lower case. */
const recipientsOf = (envelopeTo: string) =>
	envelopeTo
		.split(",")
		.map((address) => address.trim().toLowerCase())
		.filter(Boolean);

/**
 * What the kept copy says once another copy came, or null when that changes nothing: it came to
 * that address too, and for the agent that made it, when it came for none.
 *
 * Only a copy proved as the kept one was counts. Mail sent again later, word for word, mustn't make
 * an old message an agent's, so a copy counts only when it came within `COPIES_WITHIN_MS` of the
 * kept one, or when its sender is proved to have addressed it there, which a copy sent again says
 * as truly as the first: a sender who retries for days doesn't lose its recipient. A retry of the
 * same copy changes nothing.
 */
export function cameAlso(
	kept: Copy,
	copy: Copy,
	now: number,
): { envelopeTo: string; cameFor: string | null } | null {
	if (copy.verifiedDomain !== kept.verifiedDomain) return null;
	if (copy.addressed !== 1 && now - kept.arrivedAt > COPIES_WITHIN_MS) return null;
	const had = recipientsOf(kept.envelopeTo);
	const to = [...new Set([...had, ...recipientsOf(copy.envelopeTo)])];
	const cameFor = kept.cameFor ?? copy.cameFor;
	if (to.length === had.length && cameFor === kept.cameFor) return null;
	const envelopeTo = to.join(", ");
	// Past the longest list, the copy changes nothing, so the agent named is always among it.
	if (envelopeTo.length > MAX_ENVELOPE_TO) return null;
	return { envelopeTo, cameFor };
}
