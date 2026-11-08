import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Paperclip, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdminRole, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime } from "#/lib/dates";
import {
	deleteMessage,
	getMessage,
	type OpenedMessage,
	originalUrl,
	type Person,
} from "#/lib/mailbox";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/mailboxes/$mailbox/$message")({
	loader: ({ params }) =>
		getMessage({
			data: { workspace: params.workspace, mailbox: params.mailbox, message: params.message },
		}),
	component: MessagePage,
});

function MessagePage() {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const message = Route.useLoaderData();
	const admin = isAdminRole(useMyRole());
	useDocumentTitle(message?.subject || "Message");

	const back = (
		<Link
			to="/$workspace/mailboxes/$mailbox"
			params={{ workspace: slug, mailbox }}
			className="text-sm text-muted-foreground underline-offset-4 hover:underline"
		>
			Back to the mailbox
		</Link>
	);

	if (!message) {
		return (
			<Notice
				title="Message not found"
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

	return (
		<article className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="space-y-3">
				{back}
				<h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">
					{message.subject || "(no subject)"}
				</h1>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
					<dt className="text-muted-foreground">From</dt>
					<dd className="min-w-0 break-words">{message.from ? person(message.from) : "(none)"}</dd>
					{message.to.length > 0 && (
						<>
							<dt className="text-muted-foreground">To</dt>
							<dd className="min-w-0 break-words">{message.to.map(person).join(", ")}</dd>
						</>
					)}
					{message.cc.length > 0 && (
						<>
							<dt className="text-muted-foreground">Cc</dt>
							<dd className="min-w-0 break-words">{message.cc.map(person).join(", ")}</dd>
						</>
					)}
					<dt className="text-muted-foreground">Arrived</dt>
					<dd>
						<time dateTime={new Date(message.arrivedAt).toISOString()}>
							{formatDateTime(message.arrivedAt)}
						</time>
					</dd>
				</dl>
				<Sender message={message} />
			</header>

			<pre className="whitespace-pre-wrap break-words rounded-lg border p-4 font-sans text-sm">
				{message.text || <span className="text-muted-foreground">(no text)</span>}
			</pre>
			{message.textCut && (
				<p className="text-sm text-muted-foreground">
					The text is too long to show in full. Download the original for the rest.
				</p>
			)}
			{message.hasHtml && (
				<p className="text-sm text-muted-foreground">
					This message also has a formatted version, which Mail doesn't show yet.
				</p>
			)}

			{message.attachments.length > 0 && (
				<section aria-labelledby="attachments-heading" className="space-y-2">
					<h2 id="attachments-heading" className="text-sm font-semibold">
						Attachments
					</h2>
					<ul className="space-y-1 text-sm">
						{message.attachments.map((attachment, index) => (
							// Attachments have no id of their own, and the list never changes.
							// biome-ignore lint/suspicious/noArrayIndexKey: see above
							<li key={index} className="flex items-center gap-2">
								<Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
								<span className="min-w-0 break-all">{attachment.name || "(no name)"}</span>
								<span className="shrink-0 text-muted-foreground">
									{attachment.type}, {formatSize(attachment.size)}
								</span>
							</li>
						))}
					</ul>
					<p className="text-sm text-muted-foreground">
						Attachments can't be opened on their own yet; they're in the original.
					</p>
				</section>
			)}

			<div className="flex flex-wrap items-start gap-2">
				<Button asChild size="sm" variant="outline">
					{/* A plain link: the download is a file, not a page of the app. */}
					<a href={originalUrl(slug, mailbox, message.id)} download>
						Download the original ({formatSize(message.size)})
					</a>
				</Button>
				{admin && <DeleteMessage id={message.id} />}
			</div>
		</article>
	);
}

/** Deletes the message for everyone, after asking. Owners and admins only. */
function DeleteMessage({ id }: { id: string }) {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const navigate = useNavigate();
	const [asking, setAsking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	return (
		<>
			<Button size="sm" variant="outline" onClick={() => setAsking(true)}>
				<Trash2 aria-hidden />
				Delete
			</Button>
			{error && (
				<p role="alert" className="basis-full text-sm text-destructive">
					{error}
				</p>
			)}
			{asking && (
				<ConfirmDialog
					title="Delete this message?"
					confirmLabel="Delete message"
					onConfirm={async () => {
						const result = await deleteMessage(slug, mailbox, id);
						if (!result.ok) {
							setError(result.error);
							return;
						}
						await navigate({
							to: "/$workspace/mailboxes/$mailbox",
							params: { workspace: slug, mailbox },
						});
					}}
					onClose={() => setAsking(false)}
				>
					It goes from the mailbox for everyone, with its original. This can't be undone.
				</ConfirmDialog>
			)}
		</>
	);
}

/**
 * Whether the From header can be believed. Only Cloudflare's DMARC pass, for the domain of the
 * address shown, says that domain sent the message. The name in front of the address is the
 * sender's to write, so the domain is named. Anything else may be forged.
 */
function Sender({ message }: { message: OpenedMessage }) {
	if (message.verifiedDomain) {
		return (
			<p className="flex items-start gap-2 text-sm text-muted-foreground">
				<ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
				<span className="min-w-0 break-words">
					Sent from <span className="font-medium text-foreground">{message.verifiedDomain}</span>,
					which Cloudflare checked. The name in front of the address isn't checked.
				</span>
			</p>
		);
	}
	return (
		<p className="flex items-center gap-2 text-sm text-muted-foreground">
			<ShieldAlert className="size-4 shrink-0" aria-hidden />
			Nothing proves who sent this message
			{message.dmarc ? ` (DMARC: ${message.dmarc})` : ""}, so don't trust the sender it names.
		</p>
	);
}

function person({ name, address }: Person): string {
	if (name && address) return `${name} <${address}>`;
	return name || address;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
