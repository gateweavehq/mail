// Ported from Gateweave Track's webhook settings (apps/web/src/components/settings/webhooks-settings.tsx).
import { useRouter } from "@tanstack/react-router";
import { Copy, Ellipsis, Plus, Send } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { useWorkspace } from "#/components/workspace/context";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { cn } from "#/lib/utils";
import {
	MAX_WEBHOOK_MAILBOXES,
	WEBHOOK_EVENTS,
	type Webhook,
	type WebhookAction,
	type WebhookAnswer,
	type WebhookDelivery,
	type WebhookEventType,
	type WorkspaceWebhooks,
	webhooksUrl,
} from "#/lib/webhooks";

const EVENT_LABELS: Record<WebhookEventType, string> = {
	"message.received": "Mail received",
};

/** A secret just made, shown once. */
interface NewSecret {
	url: string;
	secret: string;
}

/** Sends a change to the workspace's webhooks, and says what came of it. */
async function change<T extends object = object>(
	slug: string,
	action: WebhookAction,
): Promise<WebhookAnswer<T>> {
	try {
		const response = await fetch(webhooksUrl(slug), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(action),
		});
		return (await response.json()) as WebhookAnswer<T>;
	} catch {
		return { ok: false, error: "Mail didn't answer. Try again." };
	}
}

export function WebhooksSettings({ data }: { data: WorkspaceWebhooks }) {
	const [creating, setCreating] = useState(false);
	const [newSecret, setNewSecret] = useState<NewSecret | null>(null);
	const { webhooks, deliveries, mailboxes } = data;

	return (
		<section aria-labelledby="webhooks-heading" className="space-y-4">
			<div className="flex flex-wrap items-start gap-4">
				<div className="min-w-0 flex-1 space-y-1">
					<h2 id="webhooks-heading" className="text-base font-semibold">
						Webhooks
					</h2>
					<p className="text-sm text-muted-foreground">
						A webhook posts each piece of mail to a URL of yours as it arrives, such as an agent's
						trigger, so it needn't wait for mail itself. It says who sent it and what it is about,
						not what it says: the receiver reads that with an agent's key. Every request is signed
						per{" "}
						<a
							href="https://www.standardwebhooks.com"
							target="_blank"
							rel="noreferrer"
							className="underline underline-offset-2 hover:text-foreground"
						>
							Standard Webhooks
						</a>
						, so the receiver can check that it came from Mail.
					</p>
				</div>
				<Button onClick={() => setCreating(true)}>
					<Plus />
					Add webhook
				</Button>
			</div>
			{newSecret && <SecretReveal newSecret={newSecret} onDone={() => setNewSecret(null)} />}
			{webhooks.length === 0 ? (
				<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
					No webhooks yet.
				</p>
			) : (
				<ul aria-label="Webhooks" className="divide-y rounded-lg border">
					{webhooks.map((webhook) => (
						<WebhookRow
							key={webhook.id}
							webhook={webhook}
							deliveries={deliveries.filter((delivery) => delivery.webhookId === webhook.id)}
							mailboxes={mailboxes}
							onSecret={setNewSecret}
						/>
					))}
				</ul>
			)}
			{creating && (
				<WebhookDialog
					mailboxes={mailboxes}
					onClose={() => setCreating(false)}
					onCreated={setNewSecret}
				/>
			)}
		</section>
	);
}

function SecretReveal({ newSecret, onDone }: { newSecret: NewSecret; onDone: () => void }) {
	async function copy() {
		try {
			await navigator.clipboard.writeText(newSecret.secret);
			toast.success("Secret copied");
		} catch {
			toast.error("Couldn't copy the secret");
		}
	}
	return (
		<div className="space-y-3 rounded-lg border bg-muted/40 p-3" aria-live="polite">
			<p className="text-sm">
				Copy the signing secret for <span className="break-all font-medium">{newSecret.url}</span>{" "}
				now and give it to the receiver. It isn't shown again.
			</p>
			<div className="flex gap-2">
				<Input
					readOnly
					value={newSecret.secret}
					aria-label="Signing secret"
					onFocus={(event) => event.currentTarget.select()}
					className="font-mono text-xs"
				/>
				<Button variant="outline" onClick={copy}>
					<Copy />
					Copy
				</Button>
			</div>
			<Button variant="outline" size="sm" onClick={onDone}>
				Done
			</Button>
		</div>
	);
}

/** Which mailboxes a webhook hears of, in words. */
function mailboxesHeard(webhook: Webhook, mailboxes: WorkspaceWebhooks["mailboxes"]): string {
	if (webhook.mailboxIds === null) return "Every mailbox";
	const names = mailboxes
		.filter((mailbox) => webhook.mailboxIds?.includes(mailbox.id))
		.map((mailbox) => mailbox.name);
	if (names.length === 0) return "No mailbox now: those it named were removed";
	return names.join(", ");
}

function WebhookRow({
	webhook,
	deliveries,
	mailboxes,
	onSecret,
}: {
	webhook: Webhook;
	deliveries: WebhookDelivery[];
	mailboxes: WorkspaceWebhooks["mailboxes"];
	onSecret: (secret: NewSecret) => void;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [action, setAction] = useState<"edit" | "rotate" | "delete" | null>(null);

	async function sendTest() {
		const result = await change(slug, { action: "test", id: webhook.id });
		if (!result.ok) {
			toast.error("Couldn't send a test", { description: result.error });
			return;
		}
		toast.success("Test event queued");
		// The delivery usually lands within a second; show its outcome.
		setTimeout(() => void router.invalidate(), 1500);
		await router.invalidate();
	}

	async function setActive(active: boolean) {
		const result = await change(slug, { action: "update", id: webhook.id, patch: { active } });
		if (!result.ok) {
			toast.error(active ? "Couldn't resume the webhook" : "Couldn't pause the webhook", {
				description: result.error,
			});
			return;
		}
		await router.invalidate();
	}

	async function rotate() {
		const result = await change<{ secret: string }>(slug, { action: "rotate", id: webhook.id });
		if (!result.ok) {
			toast.error("Couldn't make a new secret", { description: result.error });
			return;
		}
		onSecret({ url: webhook.url, secret: result.secret });
		await router.invalidate();
	}

	async function remove() {
		const result = await change(slug, { action: "delete", id: webhook.id });
		if (!result.ok) {
			toast.error("Couldn't delete the webhook", { description: result.error });
			return;
		}
		toast.success("Webhook deleted");
		await router.invalidate();
	}

	const scope = [
		webhook.events.map((event) => EVENT_LABELS[event]).join(", "),
		mailboxesHeard(webhook, mailboxes),
	];

	return (
		<li className="space-y-2 px-4 py-3">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1 space-y-1">
					<p className="flex items-center gap-2 text-sm font-medium">
						<span className="truncate font-mono text-xs">{webhook.url}</span>
						{!webhook.active && (
							<span className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
								Paused
							</span>
						)}
					</p>
					<p className="text-xs text-muted-foreground">{scope.join(" · ")}</p>
					<p className="text-xs text-muted-foreground">
						Secret <span className="font-mono">{webhook.secretStart}…</span>
					</p>
				</div>
				{webhook.active && (
					<Button variant="outline" size="sm" onClick={sendTest}>
						<Send />
						<span className="sr-only sm:not-sr-only">Send test</span>
					</Button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-8"
							aria-label={`More for ${webhook.url}`}
						>
							<Ellipsis />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => setAction("edit")}>Edit</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => setActive(!webhook.active)}>
							{webhook.active ? "Pause" : "Resume"}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => setAction("rotate")}>New secret</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => setAction("delete")}
						>
							Delete webhook
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<Deliveries deliveries={deliveries} />
			{action === "edit" && (
				<WebhookDialog webhook={webhook} mailboxes={mailboxes} onClose={() => setAction(null)} />
			)}
			{action === "rotate" && (
				<ConfirmDialog
					title="Make a new secret?"
					confirmLabel="Make a new secret"
					onConfirm={rotate}
					onClose={() => setAction(null)}
				>
					Deliveries are signed with the new secret from now on. Until the receiver has it, they
					fail and are retried.
				</ConfirmDialog>
			)}
			{action === "delete" && (
				<ConfirmDialog
					title="Delete this webhook?"
					confirmLabel="Delete"
					onConfirm={remove}
					onClose={() => setAction(null)}
				>
					Mail stops sending to <span className="break-all">{webhook.url}</span>, including what it
					hadn't delivered yet.
				</ConfirmDialog>
			)}
		</li>
	);
}

function Deliveries({ deliveries }: { deliveries: WebhookDelivery[] }) {
	if (deliveries.length === 0) {
		return <p className="text-xs text-muted-foreground">Nothing sent yet.</p>;
	}
	return (
		<details className="group text-xs">
			<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
				Recent deliveries
			</summary>
			<ul className="mt-2 space-y-1" aria-label="Recent deliveries">
				{deliveries.map((delivery) => (
					<li key={delivery.id} className="flex flex-wrap items-center gap-x-3">
						<DeliveryStatus delivery={delivery} />
						<span className="font-mono">{delivery.event}</span>
						<span className="text-muted-foreground" title={formatDateTime(delivery.createdAt)}>
							{formatRelative(delivery.createdAt)}
						</span>
						<span className="min-w-0 flex-1 truncate text-muted-foreground">
							{describeDelivery(delivery)}
						</span>
					</li>
				))}
			</ul>
		</details>
	);
}

function DeliveryStatus({ delivery }: { delivery: WebhookDelivery }) {
	const label = { delivered: "Delivered", pending: "Retrying", failed: "Failed" }[delivery.status];
	const shown = delivery.status === "pending" && delivery.attempts === 0 ? "Queued" : label;
	return (
		<span className="flex items-center gap-1.5">
			<span
				aria-hidden
				className={cn(
					"size-2 rounded-full",
					delivery.status === "delivered" && "bg-emerald-500",
					delivery.status === "pending" && "bg-amber-500",
					delivery.status === "failed" && "bg-destructive",
				)}
			/>
			{shown}
		</span>
	);
}

function describeDelivery(delivery: WebhookDelivery): string {
	const attempts = delivery.attempts === 1 ? "1 attempt" : `${delivery.attempts} attempts`;
	if (delivery.status === "delivered") return `${delivery.responseStatus} · ${attempts}`;
	if (delivery.attempts === 0) return delivery.error ?? "";
	const next =
		delivery.status === "pending" && delivery.nextAttemptAt
			? ` · next ${formatRelative(delivery.nextAttemptAt)}`
			: "";
	return `${delivery.error ?? "Failed"} · ${attempts}${next}`;
}

/** Adds a webhook, or edits one when given it. */
function WebhookDialog({
	webhook,
	mailboxes,
	onClose,
	onCreated,
}: {
	webhook?: Webhook;
	mailboxes: WorkspaceWebhooks["mailboxes"];
	onClose: () => void;
	onCreated?: (secret: NewSecret) => void;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const formId = useId();
	const [url, setUrl] = useState(webhook?.url ?? "");
	const [events, setEvents] = useState<WebhookEventType[]>(webhook?.events ?? ["message.received"]);
	const [everyMailbox, setEveryMailbox] = useState(webhook ? webhook.mailboxIds === null : true);
	// Those still in the workspace: a removed mailbox's id would be refused.
	const [chosen, setChosen] = useState<string[]>(
		(webhook?.mailboxIds ?? []).filter((id) => mailboxes.some((mailbox) => mailbox.id === id)),
	);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function toggleEvent(event: WebhookEventType, on: boolean) {
		setEvents((current) =>
			on ? [...current, event] : current.filter((candidate) => candidate !== event),
		);
	}

	function toggleMailbox(id: string, on: boolean) {
		setChosen((current) => (on ? [...current, id] : current.filter((one) => one !== id)));
	}

	const ready =
		url.trim() !== "" &&
		events.length > 0 &&
		(everyMailbox || (chosen.length > 0 && chosen.length <= MAX_WEBHOOK_MAILBOXES));

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const input = { url: url.trim(), events, mailboxIds: everyMailbox ? null : chosen };
		if (webhook) {
			const result = await change(slug, { action: "update", id: webhook.id, patch: input });
			if (!result.ok) {
				setPending(false);
				setError(result.error);
				return;
			}
		} else {
			const result = await change<{ webhook: Webhook; secret: string }>(slug, {
				action: "create",
				input,
			});
			if (!result.ok) {
				setPending(false);
				setError(result.error);
				return;
			}
			// The secret first, since it is shown only once, whatever happens to the reload.
			onCreated?.({ url: result.webhook.url, secret: result.secret });
		}
		// The dialog closes on the list as it now is, not on the list from before.
		try {
			await router.invalidate();
		} finally {
			onClose();
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{webhook ? "Edit webhook" : "Add webhook"}</DialogTitle>
					<DialogDescription>
						Mail posts each event as JSON, signed with the webhook's secret, and retries for about a
						day while the receiver fails.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor={`${formId}-url`}>URL</Label>
						<Input
							id={`${formId}-url`}
							type="url"
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							placeholder="https://example.com/hooks/mail"
							maxLength={2048}
							required
						/>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">Events</legend>
						{WEBHOOK_EVENTS.map((name) => (
							<div key={name} className="flex items-center gap-2">
								<Checkbox
									id={`${formId}-${name}`}
									checked={events.includes(name)}
									onCheckedChange={(checked) => toggleEvent(name, checked === true)}
								/>
								<Label htmlFor={`${formId}-${name}`} className="font-normal">
									{EVENT_LABELS[name]}
								</Label>
							</div>
						))}
					</fieldset>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">Mailboxes</legend>
						<div className="flex items-center gap-2">
							<Checkbox
								id={`${formId}-every`}
								checked={everyMailbox}
								onCheckedChange={(checked) => setEveryMailbox(checked === true)}
							/>
							<Label htmlFor={`${formId}-every`} className="font-normal">
								Every mailbox, those made later too
							</Label>
						</div>
						{!everyMailbox &&
							(mailboxes.length === 0 ? (
								<p className="text-xs text-muted-foreground">The workspace has no mailboxes yet.</p>
							) : (
								<div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
									{mailboxes.map((mailbox) => (
										<div key={mailbox.id} className="flex min-w-0 items-center gap-2">
											<Checkbox
												id={`${formId}-box-${mailbox.id}`}
												checked={chosen.includes(mailbox.id)}
												onCheckedChange={(checked) => toggleMailbox(mailbox.id, checked === true)}
											/>
											<Label
												htmlFor={`${formId}-box-${mailbox.id}`}
												className="min-w-0 truncate font-normal"
											>
												{mailbox.name}
											</Label>
										</div>
									))}
								</div>
							))}
					</fieldset>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || !ready}>
							{webhook ? "Save" : "Add webhook"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
