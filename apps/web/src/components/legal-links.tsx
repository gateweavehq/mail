import { type LegalLinks as Links, legalEntries } from "#/lib/legal";

// In a new tab, so what is half typed on this page stays. Without a referrer, since some of these
// pages have a token in their address.
const LEAVING = { target: "_blank", rel: "noreferrer" } as const;

/**
 * A line of links to the deployment's legal pages, or nothing when it has none. `agreeing` is for
 * where an account is made, by a form or a provider's button: terms bind only someone told of them.
 */
export function LegalLinks({ links, agreeing }: { links: Links | undefined; agreeing?: boolean }) {
	const entries = legalEntries(links);
	if (entries.length === 0) return null;
	return (
		<footer className="space-y-1 text-center text-xs text-muted-foreground">
			{agreeing && links?.terms && (
				<p>
					By continuing, you agree to the{" "}
					<a href={links.terms} {...LEAVING} className="underline underline-offset-4">
						Terms
					</a>
					.
				</p>
			)}
			<nav aria-label="Legal" className="flex flex-wrap justify-center gap-x-3">
				{entries.map(({ kind, label, href }) => (
					<a
						key={kind}
						href={href}
						{...LEAVING}
						className="underline-offset-4 hover:text-foreground hover:underline"
					>
						{label}
					</a>
				))}
			</nav>
		</footer>
	);
}
