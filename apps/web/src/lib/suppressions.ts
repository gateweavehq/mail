import type { SendsWith } from "./providers";

/**
 * Why Mail won't send to an address, weakest first: the provider's own suppression list has it
 * (`rejected`), mail to it bounced for good (`bounced`), or its person marked mail as spam
 * (`complained`). A stronger reason replaces a weaker one.
 */
export const SUPPRESSION_REASONS = ["rejected", "bounced", "complained"] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const SUPPRESSION_RANK: Record<SuppressionReason, number> = {
	rejected: 0,
	bounced: 1,
	complained: 2,
};

/**
 * How long a suppression lasts when it isn't for good, as Email Service's own last: a hard bounce
 * for a mailbox that may come back, or the provider's list refusing an address.
 */
export const SUPPRESSION_DAYS = 7;

/** One address of a workspace that Mail won't send to. */
export type Suppression = {
	id: string;
	/** Lower case. */
	address: string;
	reason: SuppressionReason;
	/** Whose event said so. */
	provider: SendsWith;
	/** What the receiving server or the provider said, cut short. */
	detail: string | null;
	/** When it was first suppressed. */
	firstAt: number;
	/** When an event last said so. */
	lastAt: number;
	/** When it ends by itself, or null for not until someone removes it. */
	expiresAt: number | null;
};

/** One page of a workspace's suppressions, the most recent first. */
export interface SuppressionsPage {
	suppressions: Suppression[];
	/** Where the next page starts, or null for none. */
	next: string | null;
}

/** A word or two for why, beside the address. */
export function suppressionLabel(reason: SuppressionReason): string {
	switch (reason) {
		case "rejected":
			return "On the provider's list";
		case "bounced":
			return "Bounced";
		case "complained":
			return "Marked as spam";
	}
}

/** What a reason means, for an admin deciding whether to remove it. */
export function suppressionMeaning(reason: SuppressionReason): string {
	switch (reason) {
		case "rejected":
			return "The provider refused to send to it, as its own list has it.";
		case "bounced":
			return "Their mail server refused mail to it for good.";
		case "complained":
			return "They marked mail from this workspace as spam.";
	}
}

/**
 * Why a message can't go, naming the addresses: what a person or an agent sees when a send, an
 * approval or a new try is refused.
 */
export function suppressedRefusal(found: Pick<Suppression, "address" | "reason">[]): string {
	const named = found
		.map(({ address, reason }) => `${address} (${suppressionLabel(reason).toLowerCase()})`)
		.join(", ");
	const them = found.length === 1 ? "it" : "them";
	return `Mail won't send to ${named}, as earlier mail ${found.length === 1 ? "to it" : "to them"} didn't get through. Take ${them} out, or an owner or admin can remove ${them} in Settings, under Suppressions.`;
}

/** Where a workspace's suppressions are listed and removed. */
export const suppressionsUrl = (workspace: string) =>
	`/api/suppressions/${encodeURIComponent(workspace)}`;
