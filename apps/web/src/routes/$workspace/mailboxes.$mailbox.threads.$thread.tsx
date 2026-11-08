import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Reply, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Composer } from "#/components/mail/composer";
import { MessageView, person, senderName } from "#/components/mail/message-view";
import { SentNotice, sentLabel } from "#/components/mail/sent-status";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatShortDate } from "#/lib/dates";
import { getMessage, getThread, type ListedMessage, type OpenedMessage } from "#/lib/mailbox";
import { canSendAgain, quoted, type Sent } from "#/lib/outbox";
import { useDocumentTitle } from "#/lib/title";

const Search = z.object({
	// Where a page of older messages starts: the oldest message of the page after it.
	beforeAt: z.number().int().nonnegative().optional().catch(undefined),
	beforeId: z.string().max(100).optional().catch(undefined),
});

export const Route = createFileRoute("/$workspace/mailboxes/$mailbox/threads/$thread")({
	validateSearch: Search,
	loaderDeps: ({ search }) => search,
	loader: ({ params, deps }) =>
		getThread({
			data: {
				workspace: params.workspace,
				mailbox: params.mailbox,
				thread: params.thread,
				before:
					deps.beforeAt !== undefined && deps.beforeId
						? { arrivedAt: deps.beforeAt, id: deps.beforeId }
						: null,
			},
		}),
	component: ThreadPage,
});

function ThreadPage() {
	const { slug } = useWorkspace();
	const { mailbox, thread } = Route.useParams();
	const search = Route.useSearch();
	const page = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();
	const heading = useRef<HTMLHeadingElement>(null);
	useDocumentTitle(page?.subject || "Thread");

	if (!page) {
		return (
			<Notice
				title="Thread not found"
				action={
					<Button asChild variant="outline">
						<Link to="/$workspace/mailboxes/$mailbox" params={{ workspace: slug, mailbox }}>
							Back to the mailbox
						</Link>
					</Button>
				}
			>
				It doesn't exist, it has no messages left, or it isn't in a workspace you belong to.
			</Notice>
		);
	}

	// Read as the loader reads it: a page of older messages has both.
	const newer = search.beforeAt !== undefined && Boolean(search.beforeId);
	const deleted = async () => {
		if (page.count <= 1) {
			await navigate({
				to: "/$workspace/mailboxes/$mailbox",
				params: { workspace: slug, mailbox },
			});
			return;
		}
		if (newer && page.messages.length <= 1) {
			// That page has nothing left, so the reader goes back to the newest.
			await navigate({
				to: "/$workspace/mailboxes/$mailbox/threads/$thread",
				params: { workspace: slug, mailbox, thread },
			});
		} else {
			await router.invalidate();
		}
		// The deleted message had the focus, so it goes somewhere that says where the reader is.
		heading.current?.focus();
	};

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<Link
					to="/$workspace/mailboxes/$mailbox"
					params={{ workspace: slug, mailbox }}
					className="text-sm text-muted-foreground underline-offset-4 hover:underline"
				>
					{page.mailbox}
				</Link>
				<h1
					ref={heading}
					tabIndex={-1}
					className="min-w-0 break-words text-xl font-semibold tracking-tight focus-visible:outline-none"
				>
					{page.subject || "(no subject)"}
				</h1>
				<p className="text-sm text-muted-foreground">
					{page.count === 1 ? "1 message" : `${page.count} messages`}
				</p>
			</header>

			{page.older && (
				<Button asChild size="sm" variant="outline">
					<Link
						to="/$workspace/mailboxes/$mailbox/threads/$thread"
						params={{ workspace: slug, mailbox, thread }}
						search={{ beforeAt: page.older.arrivedAt, beforeId: page.older.id }}
					>
						Older messages
					</Link>
				</Button>
			)}

			<ol aria-label="Messages in this thread" className="space-y-3">
				{page.messages.map((listed) => {
					const opened = listed.id === page.latest?.id ? page.latest : null;
					return (
						<ThreadMessage
							// A message that becomes the newest, when the one after it is deleted, opens.
							key={opened ? `${listed.id}:opened` : listed.id}
							listed={listed}
							opened={opened}
							onDeleted={deleted}
							onChanged={() => router.invalidate()}
						/>
					);
				})}
			</ol>

			{!newer && page.latest && (
				// A reply begun in one thread doesn't follow the person into another.
				<ReplyToLatest key={thread} latest={page.latest} senders={page.from} />
			)}

			{newer && (
				<Button asChild size="sm" variant="outline">
					<Link
						to="/$workspace/mailboxes/$mailbox/threads/$thread"
						params={{ workspace: slug, mailbox, thread }}
					>
						Newest messages
					</Link>
				</Button>
			)}
		</div>
	);
}

/**
 * A reply to the thread's newest message, from the mailbox: it goes to whoever that message asks
 * replies to go to, quoting it. Once sent, its copy is the thread's newest message.
 */
function ReplyToLatest({ latest, senders }: { latest: OpenedMessage; senders: string[] }) {
	const { slug } = useWorkspace();
	const { mailbox, thread } = Route.useParams();
	const router = useRouter();
	const navigate = useNavigate();
	// The message being answered, kept as it was when Reply was pressed: a newer one that comes in
	// meanwhile doesn't change what the reply answers.
	const [answering, setAnswering] = useState<OpenedMessage | null>(null);
	const writing = answering !== null;
	const [said, setSaid] = useState("");
	const button = useRef<HTMLButtonElement>(null);
	const wasWriting = useRef(false);

	// Sent or not, the focus goes back to Reply rather than to nowhere.
	useEffect(() => {
		if (!writing && wasWriting.current) button.current?.focus();
		wasWriting.current = writing;
	}, [writing]);

	const sent = async (copy: Sent) => {
		setAnswering(null);
		setSaid(
			copy.state === "sent"
				? "Your reply is sent."
				: copy.state === "sending"
					? "Your reply is being sent."
					: copy.state === "waiting"
						? "Your reply waits to be sent."
						: "Your reply isn't sent. Its copy above says why.",
		);
		if (copy.threadId !== thread) {
			await navigate({
				to: "/$workspace/mailboxes/$mailbox/threads/$thread",
				params: { workspace: slug, mailbox, thread: copy.threadId },
			});
		} else {
			await router.invalidate();
		}
	};

	return (
		<section aria-label="Reply" className="space-y-3">
			{answering && (
				<div className="rounded-lg border p-4">
					<Composer
						workspace={slug}
						mailbox={mailbox}
						senders={senders}
						replyTo={answering.id}
						draft={{
							to: answering.reply.to,
							cc: answering.reply.cc,
							subject: answering.reply.subject,
							text: quoted(
								answering.text,
								`On ${formatDateTime(answering.arrivedAt)}, ${answering.from ? person(answering.from) : "Someone"} wrote:`,
							),
							from: answering.reply.from ?? senders[0] ?? "",
						}}
						onSent={sent}
						onCancel={() => setAnswering(null)}
					/>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-3">
				{!writing && (
					<Button
						ref={button}
						size="sm"
						onClick={() => {
							setSaid("");
							setAnswering(latest);
						}}
					>
						<Reply aria-hidden />
						Reply
					</Button>
				)}
				{/* Always there, so that what it comes to say is read out. */}
				<p role="status" className="text-sm text-muted-foreground">
					{said}
				</p>
			</div>
		</section>
	);
}

/** One message of the thread: a line saying who and when, which opens to the whole message. */
function ThreadMessage({
	listed,
	opened,
	onDeleted,
	onChanged,
}: {
	listed: ListedMessage;
	/** Already read, for the newest message, which starts open. */
	opened: OpenedMessage | null;
	onDeleted: () => Promise<void>;
	/** After it was sent again, to read how it went. */
	onChanged: () => Promise<void>;
}) {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const [open, setOpen] = useState(opened !== null);
	// The newest message comes with the page, so it is as fresh as the page; another is read when
	// opened, and read again when it changes here, as when it is approved.
	const [loaded, setLoaded] = useState<OpenedMessage | null>(null);
	const message = opened ?? loaded;
	const [trouble, setTrouble] = useState<string | null>(null);
	const id = useId();
	const Chevron = open ? ChevronDown : ChevronRight;

	const toggle = async () => {
		if (open) {
			setOpen(false);
			return;
		}
		setOpen(true);
		if (!message) await load();
	};

	async function load() {
		setTrouble(null);
		try {
			const read = await getMessage({ data: { workspace: slug, mailbox, message: listed.id } });
			if (read) setLoaded(read);
			else setTrouble("This message is gone.");
		} catch {
			setTrouble("It didn't load. Close it and try again.");
		}
	}

	return (
		<li>
			<article aria-labelledby={`${id}-heading`} className="rounded-lg border">
				<h2 id={`${id}-heading`} className="text-sm">
					<button
						type="button"
						aria-expanded={open}
						aria-controls={`${id}-body`}
						onClick={toggle}
						className="flex w-full items-baseline gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
					>
						<Chevron className="size-4 shrink-0 self-center text-muted-foreground" aria-hidden />
						<span className="min-w-0 flex-1 truncate font-medium">{senderName(listed.from)}</span>
						{listed.sent && sentLabel(listed.sent.status) && (
							<span
								className={`shrink-0 self-center rounded-full border px-2 text-xs ${
									canSendAgain(listed.sent.status)
										? "border-destructive/50 text-foreground"
										: "text-muted-foreground"
								}`}
							>
								{sentLabel(listed.sent.status)}
							</span>
						)}
						{listed.verifiedDomain && (
							<span
								className="flex max-w-[40%] shrink-0 items-center gap-1 self-center text-xs text-muted-foreground"
								title={`Cloudflare checked that ${listed.verifiedDomain} sent it`}
							>
								<ShieldCheck className="size-3.5 shrink-0" aria-hidden />
								<span className="sr-only">Sent from </span>
								<span className="truncate">{listed.verifiedDomain}</span>
							</span>
						)}
						<time
							className="shrink-0 text-xs text-muted-foreground"
							dateTime={new Date(listed.arrivedAt).toISOString()}
							title={formatDateTime(listed.arrivedAt)}
						>
							{formatShortDate(listed.arrivedAt)}
						</time>
					</button>
				</h2>
				{open && (
					<div id={`${id}-body`} className="space-y-4 border-t px-4 py-4">
						{listed.sent && (
							<SentNotice
								workspace={slug}
								mailbox={mailbox}
								id={listed.id}
								status={listed.sent.status}
								mine={listed.sent.mine}
								onChanged={async () => {
									await onChanged();
									if (!opened && loaded) await load();
								}}
								onDiscarded={onDeleted}
							/>
						)}
						{message ? (
							<MessageView
								workspace={slug}
								mailbox={mailbox}
								message={message}
								onDeleted={onDeleted}
								level={3}
							/>
						) : trouble ? (
							<p role="alert" className="text-sm text-destructive">
								{trouble}
							</p>
						) : (
							<p className="text-sm text-muted-foreground">Opening…</p>
						)}
					</div>
				)}
			</article>
		</li>
	);
}
