import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Clock, PenLine, Search as SearchIcon, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Composer } from "#/components/mail/composer";
import { senderName } from "#/components/mail/message-view";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatShortDate } from "#/lib/dates";
import { type AwaitingMessage, getThreads, type ListedThread, MAX_QUERY_SENT } from "#/lib/mailbox";
import { useDocumentTitle } from "#/lib/title";

/** What agents wrote here that waits for someone to approve it, the oldest first. */
function Awaiting({ awaiting }: { awaiting: { count: number; messages: AwaitingMessage[] } }) {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const more = awaiting.count - awaiting.messages.length;
	return (
		<section aria-labelledby="awaiting-heading" className="space-y-2 rounded-lg border p-4">
			<h2 id="awaiting-heading" className="flex items-center gap-2 text-sm font-medium">
				<Clock className="size-4 shrink-0" aria-hidden />
				{awaiting.count === 1
					? "1 message waits for approval"
					: `${awaiting.count} messages wait for approval`}
			</h2>
			<p className="text-sm text-muted-foreground">
				An agent wrote {awaiting.count === 1 ? "it" : "them"} to someone it may not mail on its own.
				Open one to approve or reject it.
			</p>
			<ul className="space-y-1 text-sm">
				{awaiting.messages.map((message) => (
					<li key={message.id} className="flex min-w-0 items-baseline gap-2">
						<Link
							to="/$workspace/mailboxes/$mailbox/threads/$thread"
							params={{ workspace: slug, mailbox, thread: message.threadId }}
							className="min-w-0 truncate underline underline-offset-4"
						>
							{message.subject || "(no subject)"}
						</Link>
						{message.by && (
							<span className="shrink-0 text-xs text-muted-foreground">{message.by}</span>
						)}
						<time
							className="ml-auto shrink-0 text-xs text-muted-foreground"
							dateTime={new Date(message.arrivedAt).toISOString()}
							title={formatDateTime(message.arrivedAt)}
						>
							{formatShortDate(message.arrivedAt)}
						</time>
					</li>
				))}
			</ul>
			{more > 0 && (
				<p className="text-sm text-muted-foreground">
					{more === 1 ? "And 1 more." : `And ${more} more.`}
				</p>
			)}
		</section>
	);
}

/** How many senders a thread's line names before saying how many more. */
const NAMED_SENDERS = 3;

const Search = z.object({
	// What someone looks for, when they search.
	q: z.string().max(MAX_QUERY_SENT).optional().catch(undefined),
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
				query: deps.q?.trim() || null,
			},
		}),
	component: MailboxPage,
});

function MailboxPage() {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const search = Route.useSearch();
	const page = Route.useLoaderData();
	const navigate = useNavigate();
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
	const query = search.q?.trim() || undefined;
	const find = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const typed = String(new FormData(event.currentTarget).get("q") ?? "").trim();
		void navigate({
			to: "/$workspace/mailboxes/$mailbox",
			params: { workspace: slug, mailbox },
			search: typed ? { q: typed } : {},
		});
	};

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<Link
						to="/$workspace"
						params={{ workspace: slug }}
						className="text-sm text-muted-foreground underline-offset-4 hover:underline"
					>
						Mailboxes
					</Link>
					<h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">{page.name}</h1>
				</div>
				<Write name={page.name} senders={page.from} />
			</header>

			<search>
				<form onSubmit={find} className="flex gap-2">
					<div className="relative min-w-0 flex-1">
						<SearchIcon
							className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
							aria-hidden
						/>
						<Input
							// A new search, or none, starts the box from what the page shows.
							key={query ?? ""}
							type="search"
							name="q"
							defaultValue={query ?? ""}
							maxLength={MAX_QUERY_SENT}
							aria-label={`Search ${page.name}`}
							placeholder="Search words, senders, attachments"
							className="pl-8"
						/>
					</div>
					<Button type="submit" variant="outline">
						Search
					</Button>
					{query && (
						<Button asChild variant="ghost">
							<Link to="/$workspace/mailboxes/$mailbox" params={{ workspace: slug, mailbox }}>
								Clear
							</Link>
						</Button>
					)}
				</form>
			</search>
			{/* Said once a search's page is shown, as the focus stays in the box. */}
			<p role="status" className="sr-only">
				{query ? searchSaid(query, page.threads.length, Boolean(page.next), older) : ""}
			</p>

			{page.awaiting && page.awaiting.count > 0 && <Awaiting awaiting={page.awaiting} />}

			{page.threads.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-muted-foreground">
					{query
						? older
							? "No older threads match."
							: "No thread has all of those words. Mail that has just arrived can take a moment to be found."
						: older
							? "No older threads."
							: "No mail yet. What arrives at its addresses shows here."}
				</p>
			) : (
				<ul
					aria-label={query ? `Threads in ${page.name} that match` : `Threads in ${page.name}`}
					className="divide-y rounded-lg border"
				>
					{page.threads.map((thread) => (
						<ThreadRow key={thread.id} thread={thread} />
					))}
				</ul>
			)}

			{(older || page.next) && (
				<nav aria-label="Pages" className="flex justify-between gap-2">
					{older ? (
						<Button asChild size="sm" variant="outline">
							<Link
								to="/$workspace/mailboxes/$mailbox"
								params={{ workspace: slug, mailbox }}
								search={query ? { q: query } : {}}
							>
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
								search={{ q: query, beforeAt: page.next.latestAt, beforeId: page.next.id }}
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
							title={`${thread.count > 1 ? "The newest message is proved" : "Proved"} to come from ${thread.latestVerifiedDomain}`}
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

/**
 * What a screen reader is told of a search's page: how many threads on it match, and the words, so
 * that two searches in a row are both said.
 */
function searchSaid(query: string, shown: number, more: boolean, older: boolean): string {
	const kind = older ? "older thread" : "thread";
	if (shown === 0) return `No ${kind} matches “${query}”.`;
	if (shown === 1 && !more) return `1 ${kind} matches “${query}”.`;
	return `${shown}${more ? " or more" : ""} ${kind}s match “${query}”.`;
}

/** A new message from the mailbox, written in a dialog. Once sent, its thread opens. */
function Write({ name, senders }: { name: string; senders: string[] }) {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	// While a message is being sent the dialog stays, so its answer isn't lost.
	const [sending, setSending] = useState(false);

	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				<PenLine aria-hidden />
				Write
			</Button>
			<Dialog open={open} onOpenChange={(next) => (next || !sending) && setOpen(next)}>
				<DialogContent
					className="max-w-2xl"
					// A click beside it shouldn't throw away what's written.
					onInteractOutside={(event) => event.preventDefault()}
					// The composer puts the focus on its first address itself.
					onOpenAutoFocus={(event) => event.preventDefault()}
				>
					<DialogHeader>
						<DialogTitle>New message</DialogTitle>
						<DialogDescription className="wrap-anywhere">From {name}</DialogDescription>
					</DialogHeader>
					<Composer
						workspace={slug}
						mailbox={mailbox}
						senders={senders}
						draft={{ to: [], cc: [], subject: "", text: "", from: senders[0] ?? "" }}
						onSent={async (sent) => {
							setOpen(false);
							await navigate({
								to: "/$workspace/mailboxes/$mailbox/threads/$thread",
								params: { workspace: slug, mailbox, thread: sent.threadId },
							});
						}}
						onCancel={() => setOpen(false)}
						onPendingChange={setSending}
					/>
				</DialogContent>
			</Dialog>
		</>
	);
}
