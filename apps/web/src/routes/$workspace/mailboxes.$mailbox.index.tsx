import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { z } from "zod";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatShortDate } from "#/lib/dates";
import { getMailbox, type ListedMessage, type Person } from "#/lib/mailbox";
import { useDocumentTitle } from "#/lib/title";

const Search = z.object({
	// Where an older page starts: the last message of the page before it.
	beforeAt: z.number().int().nonnegative().optional().catch(undefined),
	beforeId: z.string().max(100).optional().catch(undefined),
});

export const Route = createFileRoute("/$workspace/mailboxes/$mailbox/")({
	validateSearch: Search,
	loaderDeps: ({ search }) => search,
	loader: ({ params, deps }) =>
		getMailbox({
			data: {
				workspace: params.workspace,
				mailbox: params.mailbox,
				before:
					deps.beforeAt !== undefined && deps.beforeId
						? { arrivedAt: deps.beforeAt, id: deps.beforeId }
						: null,
			},
		}),
	component: MailboxPage,
});

function MailboxPage() {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const search = Route.useSearch();
	const page = Route.useLoaderData();
	useDocumentTitle(page?.name ?? "Mailbox");

	if (!page) {
		return (
			<Notice
				title="Mailbox not found"
				action={
					<Button asChild variant="outline">
						<Link to="/$workspace" params={{ workspace: slug }}>
							All mailboxes
						</Link>
					</Button>
				}
			>
				It doesn't exist, or it isn't in a workspace you belong to.
			</Notice>
		);
	}

	const older = search.beforeId !== undefined;

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<Link
					to="/$workspace"
					params={{ workspace: slug }}
					className="text-sm text-muted-foreground underline-offset-4 hover:underline"
				>
					Mailboxes
				</Link>
				<h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">{page.name}</h1>
			</header>

			{page.messages.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-muted-foreground">
					{older ? "No older messages." : "No mail yet. What arrives at its addresses shows here."}
				</p>
			) : (
				<ul aria-label={`Messages in ${page.name}`} className="divide-y rounded-lg border">
					{page.messages.map((message) => (
						<MessageRow key={message.id} message={message} />
					))}
				</ul>
			)}

			{(older || page.next) && (
				<nav aria-label="Pages" className="flex justify-between gap-2">
					{older ? (
						<Button asChild size="sm" variant="outline">
							<Link to="/$workspace/mailboxes/$mailbox" params={{ workspace: slug, mailbox }}>
								Newest
							</Link>
						</Button>
					) : (
						<span />
					)}
					{page.next && (
						<Button asChild size="sm" variant="outline">
							<Link
								to="/$workspace/mailboxes/$mailbox"
								params={{ workspace: slug, mailbox }}
								search={{ beforeAt: page.next.arrivedAt, beforeId: page.next.id }}
							>
								Older
							</Link>
						</Button>
					)}
				</nav>
			)}
		</div>
	);
}

function MessageRow({ message }: { message: ListedMessage }) {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	// One line from `sm` up. On a phone, two: who and when, then what and the proved domain.
	const arrived = (className: string) => (
		<time
			className={`shrink-0 text-xs text-muted-foreground ${className}`}
			dateTime={new Date(message.arrivedAt).toISOString()}
			title={formatDateTime(message.arrivedAt)}
		>
			{formatShortDate(message.arrivedAt)}
		</time>
	);
	return (
		<li>
			<Link
				to="/$workspace/mailboxes/$mailbox/$message"
				params={{ workspace: slug, mailbox, message: message.id }}
				className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:flex-row sm:items-baseline sm:gap-3"
			>
				<span className="flex min-w-0 items-baseline gap-3 sm:w-48 sm:shrink-0">
					<span className="min-w-0 flex-1 truncate text-sm font-medium">
						{senderName(message.from)}
					</span>
					{arrived("sm:hidden")}
				</span>
				<span className="flex min-w-0 flex-1 items-baseline gap-3">
					<span className="min-w-0 flex-1 truncate text-sm">
						{message.subject || <span className="text-muted-foreground">(no subject)</span>}
					</span>
					{message.verifiedDomain && (
						// The domain, not only a mark: the name beside it is the sender's to write.
						<span
							className="flex max-w-[45%] shrink-0 items-center gap-1 self-center text-xs text-muted-foreground sm:max-w-48"
							title={`Cloudflare checked that ${message.verifiedDomain} sent it`}
						>
							<ShieldCheck className="size-3.5 shrink-0" aria-hidden />
							<span className="sr-only">Sent from </span>
							<span className="truncate">{message.verifiedDomain}</span>
						</span>
					)}
					{arrived("hidden sm:inline")}
				</span>
			</Link>
		</li>
	);
}

/** Who a message says it is from, as short as it can be said. */
function senderName(from: Person | null): string {
	if (!from) return "(no sender)";
	return from.name || from.address || "(no sender)";
}
