/** Where this deployment's legal pages are. Whoever runs it sets them; see docs/self-hosting.md. */
export interface LegalLinks {
	notice?: string;
	privacy?: string;
	terms?: string;
}

const LABELS = { notice: "Legal notice", privacy: "Privacy", terms: "Terms" } as const;

/** The links that are set, in the order they are shown. */
export function legalEntries(links: LegalLinks | undefined) {
	return (["notice", "privacy", "terms"] as const).flatMap((kind) => {
		const href = links?.[kind];
		return href ? [{ kind, label: LABELS[kind], href }] : [];
	});
}
