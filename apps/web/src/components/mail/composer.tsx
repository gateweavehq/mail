import {
	Bold,
	Italic,
	Link,
	List,
	ListOrdered,
	type LucideIcon,
	Paperclip,
	Quote,
	X,
} from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
	formatted,
	htmlOfText,
	insertLink,
	type LineKind,
	type TextEdit,
	toggleLines,
	toggleMark,
} from "#/lib/formatting";
import {
	changeOutbox,
	fileNameRefusal,
	isAddress,
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS,
	MAX_RECIPIENTS,
	MAX_SUBJECT,
	MAX_TEXT,
	type Sent,
	typedAddresses,
} from "#/lib/outbox";
import { formatSize } from "./message-view";

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
 * A message to write from a mailbox: who it goes to, its subject, its text with any formatting,
 * and its files, and, where the mailbox has more than one address it may send from, which. The
 * server checks all of it again.
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
	const fileField = useRef<HTMLInputElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const [from, setFrom] = useState(draft.from);
	const [to, setTo] = useState(draft.to.join(", "));
	const [cc, setCc] = useState(draft.cc.join(", "));
	const [subject, setSubject] = useState(draft.subject);
	const [text, setText] = useState(draft.text);
	const [files, setFiles] = useState<File[]>([]);
	const [preview, setPreview] = useState(false);
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
		const attachments = await readFiles(files);
		if (typeof attachments === "string") {
			busy(false);
			setError(attachments);
			return;
		}
		const result = await changeOutbox<Sent>(workspace, mailbox, {
			action: "send",
			...message,
			subject: subject.trim(),
			html: htmlOfText(text),
			attachments,
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

	/** Changes the text as a toolbar button or its keys say, keeping what was typed undoable. */
	function edit(change: (value: string, start: number, end: number) => TextEdit) {
		const field = textField.current;
		if (!field || locked || pending) return;
		const made = change(field.value, field.selectionStart, field.selectionEnd);
		field.focus();
		field.setSelectionRange(made.from, made.to);
		// Typing it in keeps it in the field's own undo history, which setting the value would lose;
		// where a browser can't, the value is set instead.
		if (!document.execCommand("insertText", false, made.insert)) {
			const value = field.value.slice(0, made.from) + made.insert + field.value.slice(made.to);
			setText(value);
			requestAnimationFrame(() => field.setSelectionRange(made.selectFrom, made.selectTo));
			return;
		}
		field.setSelectionRange(made.selectFrom, made.selectTo);
	}

	const bold = () => edit((v, s, e) => toggleMark(v, s, e, "**"));
	const italic = () => edit((v, s, e) => toggleMark(v, s, e, "_"));
	const link = () => edit(insertLink);
	const tools: { label: string; keys?: string; icon: LucideIcon; run: () => void }[] = [
		{ label: "Bold", keys: "Ctrl+B", icon: Bold, run: bold },
		{ label: "Italic", keys: "Ctrl+I", icon: Italic, run: italic },
		{ label: "Link", keys: "Ctrl+K", icon: Link, run: link },
		...(
			[
				["Bulleted list", List, "bullet"],
				["Numbered list", ListOrdered, "number"],
				["Quote", Quote, "quote"],
			] as const
		).map(([label, icon, kind]: readonly [string, LucideIcon, LineKind]) => ({
			label,
			icon,
			run: () => edit((v, s, e) => toggleLines(v, s, e, kind)),
		})),
	];

	// The keys for bold, italic and a link, in the text.
	function onTextKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
		const run = ({ b: bold, i: italic, k: link } as Record<string, () => void>)[
			event.key.toLowerCase()
		];
		if (!run) return;
		event.preventDefault();
		run();
	}

	/** Adds files, unless one can't go; then none of them are added, and it says why. */
	function addFiles(added: File[]) {
		if (locked || pending || added.length === 0) return;
		for (const file of added) {
			const refusal =
				fileNameRefusal(file.name) ?? (file.size === 0 ? `${file.name} is empty.` : null);
			if (refusal) {
				setError(refusal);
				return;
			}
		}
		const all = [...files, ...added];
		if (all.length > MAX_ATTACHMENTS) {
			setError(`One message can carry at most ${MAX_ATTACHMENTS} files.`);
			return;
		}
		if (all.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) {
			setError(`A message's files can hold ${formatSize(MAX_ATTACHMENT_BYTES)} together at most.`);
			return;
		}
		setError(null);
		setFiles(all);
	}

	function onDragOver(event: DragEvent) {
		if (event.dataTransfer.types.includes("Files")) event.preventDefault();
	}

	function onDrop(event: DragEvent) {
		if (event.dataTransfer.files.length === 0) return;
		event.preventDefault();
		addFiles([...event.dataTransfer.files]);
	}

	// A file pasted into the text, such as a picture, comes as a file of the message.
	function onPaste(event: ClipboardEvent) {
		if (event.clipboardData.files.length === 0) return;
		event.preventDefault();
		addFiles([...event.clipboardData.files]);
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
	const fixed = locked || pending;
	const bytes = files.reduce((sum, file) => sum + file.size, 0);

	return (
		<form
			onSubmit={onSubmit}
			onKeyDown={onKeyDown}
			onDragOver={onDragOver}
			onDrop={onDrop}
			className="space-y-3"
			noValidate
		>
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
			<div className="rounded-md border border-input shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
				<div className="flex flex-wrap items-center gap-0.5 border-b border-input p-1">
					<fieldset
						disabled={fixed || preview}
						className="m-0 flex min-w-0 flex-wrap gap-0.5 border-0 p-0"
					>
						<legend className="sr-only">Formatting</legend>
						{tools.map(({ label, keys, icon: Icon, run }) => (
							<Button
								key={label}
								type="button"
								size="icon"
								variant="ghost"
								className="size-8"
								aria-label={label}
								title={keys ? `${label} (${keys})` : label}
								aria-keyshortcuts={keys?.replace("Ctrl", "Control")}
								onClick={run}
							>
								<Icon aria-hidden />
							</Button>
						))}
					</fieldset>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="ml-auto aria-pressed:bg-accent aria-pressed:text-accent-foreground"
						aria-pressed={preview}
						onClick={() => setPreview(!preview)}
					>
						Preview
					</Button>
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
					hidden={preview}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onTextKeyDown}
					onPaste={onPaste}
					aria-describedby={`${id}-formatting`}
					className="rounded-none border-0 text-sm shadow-none focus-visible:ring-0"
				/>
				{preview && <Preview text={text} />}
			</div>
			<p id={`${id}-formatting`} className="text-xs text-muted-foreground">
				Marks such as **bold**, _italic_ or &gt; for a quote format the text. With any, it goes as
				HTML too, beside the text as written.
			</p>
			<div className="space-y-2">
				<input
					ref={fileField}
					type="file"
					multiple
					hidden
					tabIndex={-1}
					aria-hidden
					onChange={(event) => {
						addFiles([...(event.target.files ?? [])]);
						event.target.value = "";
					}}
				/>
				{files.length > 0 && (
					<ul aria-label="Files" className="flex flex-wrap gap-2">
						{files.map((file, index) => (
							<li
								// A file has no id of its own, and two may share a name.
								// biome-ignore lint/suspicious/noArrayIndexKey: the list only grows at its end or loses one by its place.
								key={index}
								className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border py-1 pr-1 pl-2 text-sm"
							>
								<Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
								<span className="min-w-0 truncate" title={file.name}>
									{file.name}
								</span>
								<span className="shrink-0 text-xs text-muted-foreground">
									{formatSize(file.size)}
								</span>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="size-6"
									aria-label={`Remove ${file.name}`}
									disabled={fixed}
									onClick={() => setFiles(files.filter((_, at) => at !== index))}
								>
									<X aria-hidden />
								</Button>
							</li>
						))}
					</ul>
				)}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={fixed}
						onClick={() => fileField.current?.click()}
					>
						<Paperclip aria-hidden />
						Attach files
					</Button>
					<span className="text-xs text-muted-foreground">
						{files.length > 0
							? `${files.length} of ${MAX_ATTACHMENTS} files, ${formatSize(bytes)} of ${formatSize(MAX_ATTACHMENT_BYTES)}.`
							: `Or drop them here. Up to ${MAX_ATTACHMENTS} files, ${formatSize(MAX_ATTACHMENT_BYTES)} together.`}
					</span>
				</div>
			</div>
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
				<span className="text-xs text-muted-foreground">Ctrl+Enter sends.</span>
			</div>
		</form>
	);
}

/**
 * How the text will look formatted, on white as a message shows. The HTML is the formatting's own,
 * which reads no HTML from the text and links only to the web and mail, so it can be shown here.
 */
function Preview({ text }: { text: string }) {
	const { html } = formatted(text);
	return (
		<section
			aria-label="Preview"
			className="max-h-[60vh] min-h-64 overflow-y-auto rounded-b-md bg-white p-4 text-sm leading-normal break-words text-black [color-scheme:light] [&_a]:text-blue-700 [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-300 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-600 [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: the formatting escapes all text and makes no tag but its own.
			dangerouslySetInnerHTML={{ __html: html || "<p>(nothing written)</p>" }}
		/>
	);
}

/** The files as a request gives them, in Base64, or why one couldn't be read. */
async function readFiles(
	files: File[],
): Promise<{ filename: string; contentType: string | null; content: string }[] | string> {
	const read = [];
	for (const file of files) {
		try {
			read.push({
				filename: file.name,
				contentType: file.type || null,
				content: await base64Of(file),
			});
		} catch {
			return `${file.name} couldn't be read. Remove it and attach it again.`;
		}
	}
	return read;
}

function base64Of(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			resolve(url.slice(url.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
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
