import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { MessageView, senderName } from "#/components/mail/message-view";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatShortDate } from "#/lib/dates";
import { getMessage, getThread, type ListedMessage, type OpenedMessage } from "#/lib/mailbox";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/mailboxes/$mailbox/threads/$thread")({
	loader: ({ params }) =>
		getThread({
			data: { workspace: params.workspace, mailbox: params.mailbox, thread: params.thread },
		}),
	component: ThreadPage,
});

function ThreadPage() {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const page = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();
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

	const deleted = async () => {
		if (page.messages.length <= 1) {
			await navigate({
				to: "/$workspace/mailboxes/$mailbox",
				params: { workspace: slug, mailbox },
			});
		} else {
			await router.invalidate();
		}
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
				<h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">
					{page.subject || "(no subject)"}
				</h1>
				<p className="text-sm text-muted-foreground">
					{page.messages.length === 1 ? "1 message" : `${page.messages.length} messages`}
				</p>
			</header>

			{page.cut && (
				<p className="text-sm text-muted-foreground">
					This thread is long, so only its newest {page.messages.length} messages are shown.
				</p>
			)}

			<ol aria-label="Messages in this thread" className="space-y-3">
				{page.messages.map((listed) => (
					<ThreadMessage
						key={listed.id}
						listed={listed}
						opened={listed.id === page.latest?.id ? page.latest : null}
						onDeleted={deleted}
					/>
				))}
			</ol>
		</div>
	);
}

/** One message of the thread: a line saying who and when, which opens to the whole message. */
function ThreadMessage({
	listed,
	opened,
	onDeleted,
}: {
	listed: ListedMessage;
	/** Already read, for the newest message, which starts open. */
	opened: OpenedMessage | null;
	onDeleted: () => Promise<void>;
}) {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const [open, setOpen] = useState(opened !== null);
	const [message, setMessage] = useState<OpenedMessage | null>(opened);
	const [trouble, setTrouble] = useState<string | null>(null);
	const id = useId();
	const Chevron = open ? ChevronDown : ChevronRight;

	const toggle = async () => {
		if (open) {
			setOpen(false);
			return;
		}
		setOpen(true);
		if (message) return;
		setTrouble(null);
		try {
			const read = await getMessage({ data: { workspace: slug, mailbox, message: listed.id } });
			if (read) setMessage(read);
			else setTrouble("This message is gone.");
		} catch {
			setTrouble("It didn't load. Close it and try again.");
		}
	};

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
					<div id={`${id}-body`} className="border-t px-4 py-4">
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
