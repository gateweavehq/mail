import { CircleAlert, Clock, Send } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdminRole, useMyRole } from "#/components/workspace/context";
import { formatDateTime } from "#/lib/dates";
import { canSendAgain, changeOutbox, refusalReason, type SendStatus } from "#/lib/outbox";

/** A word or two for how a message the mailbox sent went, for its line in a thread. */
export function sentLabel(status: SendStatus | null): string | null {
	switch (status?.state) {
		case "sending":
			return "Sending…";
		case "sent":
			return "Sent";
		case "waiting":
			return "Waiting to send";
		case "refused":
			return "Not sent";
		case "uncertain":
			return "May not have gone";
		case "discarded":
			return "Discarded";
		default:
			return null;
	}
}

/**
 * What became of a message the mailbox sent, when it isn't simply sent, and what can be done: try
 * again, or discard it, which takes its copy out of the mailbox too.
 */
export function SentNotice({
	workspace,
	mailbox,
	id,
	status,
	mine,
	onChanged,
	onDiscarded,
}: {
	workspace: string;
	mailbox: string;
	id: string;
	status: SendStatus | null;
	/** Whether whoever reads it wrote it, who may discard it, as an owner or admin may. */
	mine: boolean;
	/** After it was sent again, to read how it went. */
	onChanged: () => Promise<void> | void;
	onDiscarded: () => Promise<void> | void;
}) {
	const [pending, setPending] = useState(false);
	const [asking, setAsking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const admin = isAdminRole(useMyRole());
	if (!status || status.state === "sent") return null;
	const discardable =
		(mine || admin) &&
		(canSendAgain(status) || status.state === "waiting" || status.state === "discarded");

	async function sendAgain() {
		setPending(true);
		setError(null);
		const result = await changeOutbox(workspace, mailbox, { action: "send-again", message: id });
		setPending(false);
		if (result.ok) await onChanged();
		else setError(result.error);
	}

	const Icon = status.state === "sending" || status.state === "waiting" ? Clock : CircleAlert;
	return (
		<div
			className={`space-y-3 rounded-lg border p-3 text-sm ${
				canSendAgain(status) ? "border-destructive/50" : ""
			}`}
		>
			<p className="flex items-start gap-2">
				<Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
				<span className="min-w-0">{said(status)}</span>
			</p>
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			{(canSendAgain(status) || discardable) && (
				<div className="flex flex-wrap gap-2">
					{canSendAgain(status) && (
						<Button size="sm" variant="outline" onClick={sendAgain} disabled={pending}>
							<Send aria-hidden />
							{pending ? "Sending…" : "Send again"}
						</Button>
					)}
					{discardable && (
						<Button size="sm" variant="ghost" onClick={() => setAsking(true)} disabled={pending}>
							Discard
						</Button>
					)}
				</div>
			)}
			{asking && (
				<ConfirmDialog
					title="Discard this message?"
					confirmLabel="Discard"
					onConfirm={async () => {
						const result = await changeOutbox(workspace, mailbox, {
							action: "discard",
							message: id,
						});
						// The dialog closes either way, and a refusal shows here.
						if (!result.ok) {
							setError(result.error);
							return;
						}
						await onDiscarded();
					}}
					onClose={() => setAsking(false)}
				>
					It won't be sent, and its copy goes from the mailbox for everyone.
				</ConfirmDialog>
			)}
		</div>
	);
}

function said(status: SendStatus): string {
	switch (status.state) {
		case "sending":
			return "Sending…";
		case "waiting": {
			const when = status.nextAt ? ` at ${formatDateTime(status.nextAt)}` : " soon";
			// Without a code, its first try never began, as when a deploy came in between.
			return status.code
				? `Email Service is busy, so Mail tries again${when}.`
				: `It isn't sent yet. Mail tries${when}.`;
		}
		case "uncertain":
			return `${
				status.code === "E_INTERNAL_SERVER_ERROR"
					? "Email Service failed while sending this"
					: "Mail lost touch with Email Service while sending this"
			}, so it may have gone or not. It isn't sent again by itself, so no one gets it twice. Send it again only if it didn't arrive.`;
		case "discarded":
			return "Discarded, so it won't be sent, but its copy is still here. Discard it again to take it out.";
		default:
			return `Not sent. ${refusalReason(status.code)}`;
	}
}
