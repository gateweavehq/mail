import { and, eq, isNotNull } from "drizzle-orm";
import type { ProviderUnlisting } from "../../lib/suppressions";
import type { Database } from "../db";
import { schema } from "../db";
import { clearEmailSendingSuppressions, type EmailSendingApi } from "../providers/email-sending";
import { openProviderKey } from "../providers/keys";
import { removeResendSuppression } from "../providers/resend";

/** What Mail may reach of the providers' own lists. */
export interface ProviderLists {
	secretsKey: string | undefined;
	resendApi: string;
	/** Null when the deployment gave Mail no token for Email Service's list. */
	emailSending: EmailSendingApi | null;
}

/**
 * Takes an address an owner or admin removed from the workspace's list off the providers' own
 * lists too, which would still stop the mail: Resend's, with the workspace's key, while one of its
 * domains sends with Resend, as that list holds for the key's whole account; and Email Service's,
 * for the workspace's own proved domains, while one sends with it, with the deployment's token.
 * What each did, for the page to say. The log names what failed, never the address.
 */
export async function unlistAtProviders(
	db: Database,
	workspaceId: string,
	address: string,
	lists: ProviderLists,
): Promise<ProviderUnlisting[]> {
	const { mailDomain } = schema;
	const domains = await db
		.select({ name: mailDomain.name, sendsWith: mailDomain.sendsWith })
		.from(mailDomain)
		.where(and(eq(mailDomain.organizationId, workspaceId), isNotNull(mailDomain.verifiedAt)))
		.all();
	const done: ProviderUnlisting[] = [];

	if (domains.some((domain) => domain.sendsWith === "resend")) {
		const opened = await openProviderKey(db, lists.secretsKey, workspaceId, "resend");
		// Without a key nothing goes through Resend, and its list can't be reached.
		if (opened.ok) {
			const outcome = await removeResendSuppression(lists.resendApi, opened.key, address);
			if (outcome === "failed") console.error("suppressions: Resend's list not changed");
			done.push({ provider: "resend", outcome });
		}
	}

	if (domains.some((domain) => domain.sendsWith === "cloudflare")) {
		if (!lists.emailSending) {
			done.push({ provider: "cloudflare", outcome: "notSetUp" });
		} else {
			const ours = new Set(domains.map((domain) => domain.name));
			const cleared = await clearEmailSendingSuppressions(lists.emailSending, address, ours);
			if (cleared.outcome === "failed") {
				console.error("suppressions: Email Service's list not changed", {
					failure: cleared.failure,
				});
				done.push({ provider: "cloudflare", outcome: "failed" });
			} else {
				done.push({ provider: "cloudflare", ...cleared });
			}
		}
	}
	return done;
}
