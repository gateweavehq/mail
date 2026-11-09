import type { SendsWith } from "./providers";

/**
 * Why Mail won't send to an address, weakest first: the provider's own suppression list has it
 * (`rejected`), mail to it bounced (`bounced`), or its person marked mail as spam
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

/**
 * What a reason means, for an admin deciding whether to remove it. A bounce is for good only when
 * the entry never ends, as when the mailbox or domain doesn't exist.
 */
export function suppressionMeaning(reason: SuppressionReason, expiresAt: number | null): string {
	switch (reason) {
		case "rejected":
			return "The provider refused to send to it, as its own list has it.";
		case "bounced":
			return expiresAt === null
				? "Their mail server refused mail to it for good: the mailbox or domain doesn't exist."
				: "Their mail server refused mail to it.";
		case "complained":
			return "They marked mail from this workspace as spam.";
	}
}

/**
 * Why a message can't go, naming the addresses: what a person or an agent sees when a send, an
 * approval or a new try is refused. The reasons are for those who may see the list, owners and
 * admins; anyone else learns only what they need to put the message right.
 */
export function suppressedRefusal(
	found: Pick<Suppression, "address" | "reason">[],
	withReasons: boolean,
): string {
	const named = found
		.map(({ address, reason }) =>
			withReasons ? `${address} (${suppressionLabel(reason).toLowerCase()})` : address,
		)
		.join(", ");
	const one = found.length === 1;
	const them = one ? "it" : "them";
	const why = withReasons ? "didn't get through" : "didn't get through or was marked as spam";
	return `Mail won't send to ${named}, as earlier mail to ${them} ${why}. Take ${them} out, or an owner or admin can remove ${them} in Settings, under Suppressions.`;
}

/** Where a workspace's suppressions are listed and removed. */
export const suppressionsUrl = (workspace: string) =>
	`/api/suppressions/${encodeURIComponent(workspace)}`;

/**
 * What removing an address from the workspace's list did to a provider's own list, which can still
 * stop the mail: Resend's for the workspace's key's account, Email Service's for the workspace's
 * domains. `kept` counts Email Service entries only whoever runs the deployment can change.
 */
export type ProviderUnlisting =
	| { provider: "resend"; outcome: "removed" | "notListed" | "sendingOnly" | "failed" }
	| { provider: "cloudflare"; outcome: "notSetUp" }
	| { provider: "cloudflare"; outcome: "failed" }
	| { provider: "cloudflare"; outcome: "done"; removed: number; kept: number };

/** What the page learns when an entry came off: what the providers' own lists did too. */
export interface RemovedAnswer {
	ok: true;
	address: string;
	providers: ProviderUnlisting[];
}

/** What the page says once an address is removed: what the providers' own lists now hold. */
export function removalWords(address: string, unlistings: ProviderUnlisting[]): string {
	const said = [`Removed ${address}.`];
	for (const one of unlistings) {
		if (one.provider === "resend") {
			if (one.outcome === "removed") said.push("Resend's own list no longer has it either.");
			if (one.outcome === "sendingOnly") {
				said.push(
					"Resend's own list may still have it, as the workspace's key can only send: remove it there too.",
				);
			}
			if (one.outcome === "failed") {
				said.push("Resend didn't answer, so its own list may still have it: remove it there too.");
			}
			continue;
		}
		if (one.outcome === "notSetUp") {
			said.push(
				"Email Service's own list may still have it, which only whoever runs this deployment can change.",
			);
		} else if (one.outcome === "failed") {
			said.push("Email Service's own list couldn't be checked just now, so it may still have it.");
		} else if (one.kept > 0) {
			said.push(
				"Email Service's own list still has it, in an entry only whoever runs this deployment can change.",
			);
		} else if (one.removed > 0) {
			said.push("Email Service's own list no longer has it either.");
		}
	}
	return said.join(" ");
}
