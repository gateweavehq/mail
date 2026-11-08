import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
	changeOutbox,
	isAddress,
	MAX_RECIPIENTS,
	MAX_SUBJECT,
	MAX_TEXT,
	type Sent,
	typedAddresses,
} from "#/lib/outbox";

/** What a message starts with. */
export interface Draft {
	to: string[];
	cc: string[];
	subject: string;
	text: string;
	/** Which of the mailbox's addresses it goes from. */
	from: string;
}

/**
 * A message to write from a mailbox: who it goes to, its subject and its text, and, where the
 * mailbox has more than one address it may send from, which. The server checks all of it again.
 */
export function Composer({
	workspace,
	mailbox,
	senders,
	draft,
	replyTo = null,
	onSent,
	onCancel,
	onPendingChange,
}: {
	workspace: string;
	mailbox: string;
	/** The addresses the mailbox may send from. */
	senders: string[];
	draft: Draft;
	/** The message this answers, in the mailbox. */
	replyTo?: string | null;
	onSent: (sent: Sent) => Promise<void> | void;
	onCancel: () => void;
	/** While it is being sent, so that what holds it stays open until the answer comes. */
	onPendingChange?: (pending: boolean) => void;
}) {
	const id = useId();
	// The draft's own id: sending it again, as after a lost answer, never sends it twice.
	const [draftId] = useState(() => crypto.randomUUID());
	const toField = useRef<HTMLInputElement>(null);
	const textField = useRef<HTMLTextAreaElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const [from, setFrom] = useState(draft.from);
	const [to, setTo] = useState(draft.to.join(", "));
	const [cc, setCc] = useState(draft.cc.join(", "));
	const [subject, setSubject] = useState(draft.subject);
	const [text, setText] = useState(draft.text);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	// Once an answer is lost the message may have gone as it was, and sending it again only says
	// what became of it, so a change made then would be dropped without a word: it can't be made.
	const [locked, setLocked] = useState(false);

	// Where writing starts: a reply's text, above the quote, or a new message's first address, or
	// Close when there is nothing to write.
	useEffect(() => {
		if (senders.length === 0) {
			closeButton.current?.focus();
		} else if (replyTo && textField.current) {
			textField.current.focus();
			textField.current.setSelectionRange(0, 0);
			textField.current.scrollTop = 0;
		} else {
			toField.current?.focus();
		}
	}, [replyTo, senders.length]);

	const busy = (now: boolean) => {
		setPending(now);
		onPendingChange?.(now);
	};

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (pending) return;
		const message = { to: typedAddresses(to), cc: typedAddresses(cc), subject, text };
		const problem = problemWith(message);
		if (problem) {
			setError(problem);
			return;
		}
		busy(true);
		setError(null);
		const result = await changeOutbox<Sent>(workspace, mailbox, {
			action: "send",
			...message,
			subject: subject.trim(),
			replyTo,
			from,
			draft: draftId,
		});
		busy(false);
		if (result.ok) await onSent(result);
		else if (result.lost) {
			setLocked(true);
			setError(
				"No answer came back, so it may have gone. Press Send again to find out: it won't go twice. Until then it can't be changed.",
			);
		} else setError(result.error);
	}

	// Ctrl or Cmd and Enter sends, as in most mail programs.
	function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			event.currentTarget.requestSubmit();
		}
	}

	if (senders.length === 0) {
		return (
			<div className="space-y-3">
				<p className="text-sm text-muted-foreground">
					This mailbox can't send yet: none of its addresses is on a domain the workspace has
					proved. An owner or admin can add one on the Mailboxes page.
				</p>
				<Button ref={closeButton} type="button" size="sm" variant="outline" onClick={onCancel}>
					Close
				</Button>
			</div>
		);
	}

	const addressProps = {
		autoComplete: "off",
		autoCapitalize: "none",
		spellCheck: false,
		inputMode: "email",
	} as const;

	return (
		<form onSubmit={onSubmit} onKeyDown={onKeyDown} className="space-y-3" noValidate>
			<div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
				{senders.length > 1 ? (
					<>
						<Label htmlFor={`${id}-from`}>From</Label>
						<select
							id={`${id}-from`}
							value={from}
							disabled={locked}
							onChange={(event) => setFrom(event.target.value)}
							className="h-9 min-w-0 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
						>
							{senders.map((address) => (
								<option key={address} value={address}>
									{address}
								</option>
							))}
						</select>
					</>
				) : (
					// Nothing to choose, so only said.
					<>
						<span className="text-sm font-medium">From</span>
						<span className="min-w-0 break-all text-sm">{from}</span>
					</>
				)}
				<Label htmlFor={`${id}-to`}>To</Label>
				<Input
					ref={toField}
					id={`${id}-to`}
					{...addressProps}
					value={to}
					readOnly={locked}
					onChange={(event) => setTo(event.target.value)}
					aria-describedby={`${id}-addresses`}
				/>
				<Label htmlFor={`${id}-cc`}>Cc</Label>
				<Input
					id={`${id}-cc`}
					{...addressProps}
					value={cc}
					readOnly={locked}
					onChange={(event) => setCc(event.target.value)}
					aria-describedby={`${id}-addresses`}
				/>
				<span />
				<p id={`${id}-addresses`} className="text-xs text-muted-foreground">
					Addresses only, separated by commas. Up to {MAX_RECIPIENTS} people in all.
				</p>
				<Label htmlFor={`${id}-subject`}>Subject</Label>
				<Input
					id={`${id}-subject`}
					autoComplete="off"
					maxLength={MAX_SUBJECT}
					value={subject}
					readOnly={locked}
					onChange={(event) => setSubject(event.target.value)}
				/>
			</div>
			<Label htmlFor={`${id}-text`} className="sr-only">
				Message
			</Label>
			<Textarea
				ref={textField}
				id={`${id}-text`}
				rows={12}
				maxLength={MAX_TEXT}
				value={text}
				readOnly={locked}
				onChange={(event) => setText(event.target.value)}
				className="text-sm"
			/>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<LiveButton type="submit" size="sm" disabled={pending}>
					{pending ? "Sending…" : "Send"}
				</LiveButton>
				<Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
					Cancel
				</Button>
				<span className="text-xs text-muted-foreground">Plain text. Ctrl+Enter sends.</span>
			</div>
		</form>
	);
}

/** What's wrong with a message before it goes to the server, in words, or null. */
function problemWith(message: { to: string[]; cc: string[]; subject: string; text: string }) {
	const everyone = [...message.to, ...message.cc];
	if (message.to.length === 0) return "Say who it goes to.";
	const wrong = everyone.find((address) => !isAddress(address));
	if (wrong) return `"${wrong}" isn't an email address.`;
	if (everyone.length > MAX_RECIPIENTS) {
		return `One message can go to at most ${MAX_RECIPIENTS} people.`;
	}
	const lower = everyone.map((address) => address.toLowerCase());
	if (new Set(lower).size !== lower.length) return "An address is there twice.";
	if (!message.subject.trim()) return "Give it a subject.";
	if (!message.text.trim()) return "Write something to send.";
	return null;
}
