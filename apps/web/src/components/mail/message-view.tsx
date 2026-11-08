import { ImageOff, Paperclip, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdminRole, useMyRole } from "#/components/workspace/context";
import { formatDateTime } from "#/lib/dates";
import {
	deleteMessage,
	htmlUrl,
	type OpenedMessage,
	originalUrl,
	type Person,
} from "#/lib/mailbox";

/**
 * A message's headers, who sent it as far as anything proves, its HTML or text and attachments, and
 * what can be done with it. The page around it gives the subject.
 */
export function MessageView({
	workspace,
	mailbox,
	message,
	onDeleted,
	level = 2,
}: {
	workspace: string;
	mailbox: string;
	message: OpenedMessage;
	/** After an owner or admin deleted it. */
	onDeleted: () => Promise<void> | void;
	/** The level of its own headings, one below the page's heading for it. */
	level?: 2 | 3;
}) {
	const admin = isAdminRole(useMyRole());
	const Heading = level === 2 ? "h2" : "h3";
	return (
		<div className="space-y-6">
			<div className="space-y-3">
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
			</div>

			{/* A new message starts with its images off, even where the page stays mounted. */}
			<Body key={message.id} workspace={workspace} mailbox={mailbox} message={message} />

			{message.attachments.length > 0 && (
				<section aria-label="Attachments" className="space-y-2">
					<Heading className="text-sm font-semibold">Attachments</Heading>
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
					<a href={originalUrl(workspace, mailbox, message.id)} download>
						Download the original ({formatSize(message.size)})
					</a>
				</Button>
				{admin && (
					<DeleteMessage
						workspace={workspace}
						mailbox={mailbox}
						id={message.id}
						onDeleted={onDeleted}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * The message as its sender formatted it, when it has HTML, or its text. The HTML is a page of its
 * own in a frame that runs nothing and, until the reader asks, loads nothing from elsewhere; see
 * `server/mailbox/html.ts`. A frame without scripts can't say how tall it is, so it has a height of
 * its own, which the reader can drag. The buttons stay where they are when pressed, and say what
 * they would do next, so the focus stays on them.
 */
function Body({
	workspace,
	mailbox,
	message,
}: {
	workspace: string;
	mailbox: string;
	message: OpenedMessage;
}) {
	const [asText, setAsText] = useState(false);
	const [images, setImages] = useState(false);
	const formatted = message.hasHtml && !asText;

	return (
		<div className="space-y-2">
			{message.hasHtml && (
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="outline" onClick={() => setAsText(!asText)}>
						{asText ? "Show formatted" : "Show as text"}
					</Button>
					{formatted && message.remoteImages && (
						<>
							<Button size="sm" variant="outline" onClick={() => setImages(!images)}>
								{images ? "Hide remote images" : "Show remote images"}
							</Button>
							{!images && (
								<p className="flex items-center gap-2 text-sm text-muted-foreground">
									<ImageOff className="size-4 shrink-0" aria-hidden />
									Remote images are off, so the sender can't tell you opened this.
								</p>
							)}
						</>
					)}
				</div>
			)}
			{formatted ? (
				<div className="h-[70vh] min-h-80 resize-y overflow-hidden rounded-lg border bg-white">
					<iframe
						title="The message, as its sender formatted it"
						src={htmlUrl(workspace, mailbox, message.id, images)}
						// The same as the page's own policy says; either one is enough.
						sandbox="allow-popups allow-popups-to-escape-sandbox"
						referrerPolicy="no-referrer"
						className="size-full"
					/>
				</div>
			) : (
				<pre className="whitespace-pre-wrap break-words rounded-lg border p-4 font-sans text-sm">
					{message.text || <span className="text-muted-foreground">(no text)</span>}
				</pre>
			)}
			{(formatted ? message.htmlCut : message.textCut) && (
				<p className="text-sm text-muted-foreground">
					{formatted ? "This message" : "The text"} is too long to show in full. Download the
					original for the rest.
				</p>
			)}
		</div>
	);
}

/** Deletes the message for everyone, after asking. Owners and admins only. */
function DeleteMessage({
	workspace,
	mailbox,
	id,
	onDeleted,
}: {
	workspace: string;
	mailbox: string;
	id: string;
	onDeleted: () => Promise<void> | void;
}) {
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
						const result = await deleteMessage(workspace, mailbox, id);
						if (!result.ok) {
							setError(result.error);
							return;
						}
						setAsking(false);
						await onDeleted();
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

export function person({ name, address }: Person): string {
	if (name && address) return `${name} <${address}>`;
	return name || address;
}

/** What a sender is called in a short line: their name, or else their address. */
export function senderName(from: Person | null): string {
	if (!from) return "(no sender)";
	return from.name || from.address || "(no sender)";
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
