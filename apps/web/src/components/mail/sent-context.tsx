import { ExternalLink } from "lucide-react";
import type { SentContext } from "#/lib/outbox";

/** The host a context's link goes to, shown beside its label, which is only its writer's words. */
export function contextHost(context: SentContext): string {
	try {
		return new URL(context.url).host;
	} catch {
		return "";
	}
}

/**
 * What a message was written for, as its writer said: its label, or the link's host, and the host
 * beside a label. A link that opens in a new tab, or plain text where it would sit in another link.
 */
export function SentFor({ context, link = true }: { context: SentContext; link?: boolean }) {
	const host = contextHost(context);
	const name = context.label ?? host;
	// Only https is kept; asked again here, as this is what puts it in a page.
	const opens = link && context.url.startsWith("https://");
	return (
		<>
			{opens ? (
				<a
					href={context.url}
					target="_blank"
					rel="noopener noreferrer nofollow"
					className="inline-flex min-w-0 items-baseline gap-1 font-medium text-foreground underline underline-offset-4"
				>
					<span className="break-all">{name}</span>
					<ExternalLink className="size-3 shrink-0 self-center" aria-hidden />
				</a>
			) : (
				<span className="font-medium text-foreground">{name}</span>
			)}
			{context.label && host && ` (${host})`}
		</>
	);
}
