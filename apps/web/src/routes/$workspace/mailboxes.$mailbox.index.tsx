import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { z } from "zod";
import { senderName } from "#/components/mail/message-view";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatShortDate } from "#/lib/dates";
import { getThreads, type ListedThread } from "#/lib/mailbox";
import { useDocumentTitle } from "#/lib/title";

/** How many senders a thread's line names before saying how many more. */
const NAMED_SENDERS = 3;

const Search = z.object({
	// Where an older page starts: the last thread of the page before it.
	beforeAt: z.number().int().nonnegative().optional().catch(undefined),
	beforeId: z.string().max(100).optional().catch(undefined),
});

export const Route = createFileRoute("/$workspace/mailboxes/$mailbox/")({
	validateSearch: Search,
	loaderDeps: ({ search }) => search,
	loader: ({ params, deps }) =>
		getThreads({
			data: {
				workspace: params.workspace,
				mailbox: params.mailbox,
				before:
					deps.beforeAt !== undefined && deps.beforeId
						? { latestAt: deps.beforeAt, id: deps.beforeId }
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

	// Read as the loader reads it: a page of older threads has both.
	const older = search.beforeAt !== undefined && Boolean(search.beforeId);

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

			{page.threads.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-muted-foreground">
					{older ? "No older threads." : "No mail yet. What arrives at its addresses shows here."}
				</p>
			) : (
				<ul aria-label={`Threads in ${page.name}`} className="divide-y rounded-lg border">
					{page.threads.map((thread) => (
						<ThreadRow key={thread.id} thread={thread} />
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
								search={{ beforeAt: page.next.latestAt, beforeId: page.next.id }}
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

function ThreadRow({ thread }: { thread: ListedThread }) {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const named = thread.senders.slice(0, NAMED_SENDERS).map(senderName);
	const others = thread.senders.length - named.length;
	// One line from `sm` up. On a phone, two: who and when, then what and the proved domain.
	const latest = (className: string) => (
		<time
			className={`shrink-0 text-xs text-muted-foreground ${className}`}
			dateTime={new Date(thread.latestAt).toISOString()}
			title={formatDateTime(thread.latestAt)}
		>
			{formatShortDate(thread.latestAt)}
		</time>
	);
	return (
		<li>
			<Link
				to="/$workspace/mailboxes/$mailbox/threads/$thread"
				params={{ workspace: slug, mailbox, thread: thread.id }}
				className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:flex-row sm:items-baseline sm:gap-3"
			>
				<span className="flex min-w-0 items-baseline gap-3 sm:w-48 sm:shrink-0">
					<span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm font-medium">
						<span className="truncate">
							{named.length > 0 ? named.join(", ") : "(no sender)"}
							{others > 0 && ` +${others}`}
							{/* Browsers put a space before text that is only for screen readers. */}
							{thread.count > 1 && <span className="sr-only">({thread.count} messages)</span>}
						</span>
						{thread.count > 1 && (
							<span aria-hidden className="shrink-0 text-xs font-normal text-muted-foreground">
								{thread.count}
							</span>
						)}
					</span>
					{latest("sm:hidden")}
				</span>
				<span className="flex min-w-0 flex-1 items-baseline gap-3">
					<span className="min-w-0 flex-1 truncate text-sm">
						{thread.subject || <span className="text-muted-foreground">(no subject)</span>}
					</span>
					{thread.latestVerifiedDomain && (
						// The domain, not only a mark: the name beside it is the sender's to write.
						<span
							className="flex max-w-[45%] shrink-0 items-center gap-1 self-center text-xs text-muted-foreground sm:max-w-48"
							title={`Cloudflare checked that ${thread.latestVerifiedDomain} sent ${thread.count > 1 ? "the newest message" : "it"}`}
						>
							<ShieldCheck className="size-3.5 shrink-0" aria-hidden />
							<span className="sr-only">
								{thread.count > 1 ? "Newest message sent from " : "Sent from "}
							</span>
							<span className="truncate">{thread.latestVerifiedDomain}</span>
						</span>
					)}
					{latest("hidden sm:inline")}
				</span>
			</Link>
		</li>
	);
}
