import { env } from "cloudflare:workers";
import type { LegalLinks } from "#/lib/legal";

/** An address people can open. Anything else is left out rather than shown as a link. */
function address(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/**
 * This deployment's legal pages. They come from its configuration and are unset by default, so a
 * copy someone else runs shows none of Gateweave's, and can show its own.
 */
export function legalLinks(): LegalLinks | undefined {
	const notice = address(env.LEGAL_NOTICE_URL);
	const privacy = address(env.PRIVACY_POLICY_URL);
	const terms = address(env.TERMS_URL);
	if (!notice && !privacy && !terms) return undefined;
	return { ...(notice && { notice }), ...(privacy && { privacy }), ...(terms && { terms }) };
}
