import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { ResendKey, type ResendKeyState } from "#/components/settings/resend-key";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdminRole, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { authClient } from "#/lib/auth-client";
import { formatDateTime, formatRelative } from "#/lib/dates";
import {
	changeDirectory,
	type DirectoryDomain,
	getDirectory,
	type MailRoute,
	type ResendReceiving,
} from "#/lib/directory";
import { type ReceivesWith, receivingTrouble, type SendsWith } from "#/lib/providers";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/domains")({
	loader: ({ params }) => getDirectory({ data: params.workspace }),
	component: DomainsPage,
});

function DomainsPage() {
	const data = Route.useLoaderData();
	const admin = isAdminRole(useMyRole());
	const { id: organizationId } = useWorkspace();
	const router = useRouter();
	const [resend, setResend] = useState<ResendKeyState | null>(null);
	useDocumentTitle("Domains");

	// Only owners and admins may know of the key, so only their page asks.
	const loadResend = useCallback(async () => {
		const result = await authClient.providers.key({
			query: { organizationId, provider: "resend" },
		});
		if (result.data) setResend(result.data);
	}, [organizationId]);
	useEffect(() => {
		if (admin) void loadResend();
	}, [admin, loadResend]);

	if (!data) {
		return (
			<Notice title="Domains unavailable">You are no longer a member of this workspace.</Notice>
		);
	}

	return (
		<div className="space-y-8">
			<section aria-labelledby="domains-heading" className="space-y-4">
				<div className="space-y-1">
					<h2 id="domains-heading" className="text-sm font-semibold">
						Domains
					</h2>
					<p className="text-sm text-muted-foreground">
						Mailboxes get addresses on domains this workspace has proved it runs. Each domain or
						subdomain is proved on its own. Whoever runs a domain's DNS decides who holds it: if
						another workspace on this server proves it later, it moves to them.
					</p>
				</div>
				{admin ? (
					<AddDomain />
				) : (
					<p className="text-sm text-muted-foreground">An owner or admin can add a domain.</p>
				)}
				{admin && (
					<WebhookStatus
						state={data.resendReceiving}
						receiving={data.domains.some((domain) => domain.receivesWith === "resend")}
						sending={data.domains.some((domain) => domain.sendsWith === "resend")}
					/>
				)}
				{data.domains.length > 0 && (
					<ul aria-label="Domains" className="space-y-3">
						{data.domains.map((domain) => (
							<DomainRow
								key={domain.id}
								domain={domain}
								admin={admin}
								keyed={resend ? resend.key !== null : null}
								webhookReady={data.resendReceiving?.ready === true}
							/>
						))}
					</ul>
				)}
			</section>

			<section aria-labelledby="sending-heading" className="space-y-3">
				<div className="space-y-1">
					<h2 id="sending-heading" className="text-sm font-semibold">
						Sending from a domain
					</h2>
					<p className="text-sm text-muted-foreground">
						Each domain sends one of two ways. Cloudflare Email Service sends from domains that the
						Cloudflare account running this server has onboarded for Email Sending. For a domain
						whose DNS is somewhere else, send through Resend: verify the domain at Resend, add the
						workspace's Resend key here, then set the domain to send with Resend. With a key that
						has full access, Mail makes a webhook in that Resend account, which tells it what became
						of each message and lets it stop writing to addresses that bounce. A key that can only
						send still sends, but Mail learns none of that.
					</p>
				</div>
				{admin ? (
					<ResendKey
						state={resend}
						onChanged={async () => {
							await loadResend();
							await router.invalidate();
						}}
					/>
				) : (
					<p className="text-sm text-muted-foreground">
						An owner or admin can add the workspace's Resend key.
					</p>
				)}
			</section>

			<section aria-labelledby="routing-heading" className="space-y-3">
				<h2 id="routing-heading" className="text-sm font-semibold">
					Getting a domain's mail to this server
				</h2>
				<p className="text-sm text-muted-foreground">
					Think before doing this for a domain people rely on: its mail is kept here and shown, and
					a message to an address that doesn't exist is refused.
				</p>
				<p className="text-sm text-muted-foreground">
					A domain's mail comes one of two ways. Through Cloudflare Email Routing, in the Cloudflare
					account that runs this server: turn it on for the domain you proved, then choose one of
					these:
				</p>
				<ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
					<li>
						<span className="font-medium text-foreground">Send its catch-all to this Worker.</span>{" "}
						This server then decides which addresses exist, and a new one works straight away. A
						zone has one catch-all, and it also catches any subdomain with Email Routing on, so use
						this where nothing else needs it.
					</li>
					<li>
						<span className="font-medium text-foreground">Add a routing rule per address.</span> Use
						this when something else holds the catch-all. A zone gets 200 rules in all, and a new
						one can take over a minute to work, with mail going to the catch-all until it does.
					</li>
				</ul>
				<p className="text-sm text-muted-foreground">
					Or through Resend, for a domain whose DNS is somewhere else. In Resend, turn on receiving
					for the domain and add the MX record it shows. Add the workspace's Resend key here, with
					full access, as a key that can only send can't read received mail. Then set the domain to
					receive with Resend: Mail makes a webhook in that Resend account, which tells it of each
					message. Resend takes every address on the domain, so mail to one that doesn't exist here
					can't be refused, only left out. A domain's mail goes to one place, so use a subdomain
					when the domain already gets mail somewhere else.
				</p>
			</section>
		</div>
	);
}

function AddDomain() {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const result = await changeDirectory(slug, { action: "add-domain", name });
		if (result.ok) {
			setName("");
			await router.invalidate();
		} else {
			setError(result.error);
		}
		setPending(false);
	}

	return (
		<form onSubmit={onSubmit} className="space-y-3 rounded-lg border p-4">
			<div className="space-y-2">
				<Label htmlFor="domain-name">Domain name</Label>
				<Input
					id="domain-name"
					autoComplete="off"
					spellCheck={false}
					placeholder="mail.example.com"
					value={name}
					onChange={(event) => setName(event.target.value)}
					required
				/>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<LiveButton type="submit" size="sm" disabled={pending || !name.trim()}>
				{pending ? "Adding…" : "Add domain"}
			</LiveButton>
		</form>
	);
}

/** What the last check found, in words. */
function checkedWords(proved: boolean, mail: MailRoute, receivesWith: ReceivesWith): string {
	if (!proved) return "No matching TXT record yet. A new one can take a few minutes to show.";
	if (receivesWith === "resend") {
		if (mail === "resend")
			return "Proved. Its MX records point to Resend, which passes its mail on.";
		if (mail === "none") {
			return "Proved, but it has no MX records yet. Add the one Resend shows for the domain.";
		}
		return "Proved, but not all its MX records point to Resend, so some or all of its mail won't reach this server.";
	}
	if (mail === "cloudflare") {
		return "Proved. Its MX records point to Cloudflare, which is right if this server's account runs it.";
	}
	if (mail === "elsewhere" || mail === "resend") {
		return "Proved, but not all its MX records point to Cloudflare, so some or all of its mail won't reach this server.";
	}
	return "Proved, but it has no MX records yet. Turning on Email Routing adds them.";
}

const RECEIVES_WITH_WORDS: Record<ReceivesWith, string> = {
	cloudflare: "Cloudflare Email Routing",
	resend: "Resend",
};

/**
 * How the workspace's webhook in Resend is, which tells Mail of mail Resend received and of what
 * became of mail it sent. With no state, the webhook isn't made: the key can only send, or a domain
 * was set to Resend while the last was turned off at the same moment.
 */
function WebhookStatus({
	state,
	receiving,
	sending,
}: {
	state: ResendReceiving | null;
	receiving: boolean;
	sending: boolean;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const [said, setSaid] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	if (!receiving && !sending) return null;

	async function check() {
		setPending(true);
		setSaid(null);
		setError(null);
		const result = await changeDirectory(slug, { action: "check-receiving" });
		if (result.ok) {
			setSaid("The webhook is in Resend and on.");
			await router.invalidate();
		} else setError(result.error);
		setPending(false);
	}

	return (
		<div className="space-y-2 rounded-lg border p-4 text-sm">
			<p className="font-medium">Resend's webhook</p>
			{!state?.ready && (
				<p className="text-destructive">
					The webhook in Resend isn't made, so{" "}
					{receiving
						? "no mail comes through it"
						: "Mail can't learn what became of mail sent through Resend, or stop writing to addresses that bounce"}
					. Check it to make it again, which needs a key with full access.
				</p>
			)}
			{state?.trouble && (
				<p role="alert" className="text-destructive">
					{receivingTrouble(state.trouble)}
					{state.troubleAt !== null && ` (${formatDateTime(state.troubleAt)})`}
				</p>
			)}
			<p className="text-muted-foreground">
				{receiving &&
					(state?.receivedAt == null
						? "No mail has come through it yet. "
						: `Mail last came through it ${formatDateTime(state.receivedAt)}. `)}
				Resend turns off a webhook whose deliveries keep failing; checking it turns it back on, and
				makes it again if Resend no longer has it.
			</p>
			<div className="flex flex-wrap items-center gap-3">
				<LiveButton size="sm" variant="outline" disabled={pending} onClick={check}>
					{pending ? "Checking…" : "Check the webhook"}
				</LiveButton>
				{/* Kept in the page, so a screen reader hears its words change. */}
				<p role="status" className="text-muted-foreground">
					{said}
				</p>
				{error && (
					<p role="alert" className="text-destructive">
						{error}
					</p>
				)}
			</div>
		</div>
	);
}

const SENDS_WITH_WORDS: Record<SendsWith, string> = {
	cloudflare: "Cloudflare Email Service",
	resend: "Resend",
};

function DomainRow({
	domain,
	admin,
	keyed,
	webhookReady,
}: {
	domain: DirectoryDomain;
	admin: boolean;
	/** Whether the workspace has a Resend key, once the page knows. */
	keyed: boolean | null;
	/** Whether the workspace's webhook in Resend is made, which `WebhookStatus` speaks for. */
	webhookReady: boolean;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [said, setSaid] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [switching, setSwitching] = useState(false);

	async function receiveWith(receivesWith: ReceivesWith) {
		setSwitching(true);
		setError(null);
		setSaid(null);
		const result = await changeDirectory(slug, {
			action: "set-domain-receiving",
			id: domain.id,
			receivesWith,
		});
		if (result.ok) await router.invalidate();
		else setError(result.error);
		setSwitching(false);
	}

	async function sendWith(sendsWith: SendsWith) {
		setSwitching(true);
		setError(null);
		setSaid(null);
		const result = await changeDirectory<{ note?: string }>(slug, {
			action: "set-domain-sending",
			id: domain.id,
			sendsWith,
		});
		if (result.ok) {
			// It sends now, but Mail may not learn what becomes of its mail: that it says.
			if (result.note) setError(result.note);
			await router.invalidate();
		} else setError(result.error);
		setSwitching(false);
	}

	async function check() {
		setPending(true);
		setError(null);
		setSaid(null);
		const result = await changeDirectory<{ proved: boolean; mail: MailRoute }>(slug, {
			action: "check-domain",
			id: domain.id,
		});
		if (result.ok) {
			setSaid(checkedWords(result.proved, result.mail, domain.receivesWith));
			await router.invalidate();
		} else {
			setError(result.error);
		}
		setPending(false);
	}

	async function remove() {
		const result = await changeDirectory(slug, { action: "remove-domain", id: domain.id });
		if (result.ok) {
			await router.invalidate();
		} else {
			setError(result.error);
		}
		setRemoving(false);
	}

	return (
		<li className="space-y-3 rounded-lg border p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="min-w-0 break-all text-sm font-medium">{domain.name}</p>
				<p className="text-sm text-muted-foreground">
					{domain.verifiedAt ? "Proved" : "Waiting for proof"}
				</p>
			</div>
			{domain.proof && (
				<div className="space-y-2 text-sm">
					<p className="text-muted-foreground">Add this TXT record to the domain's DNS:</p>
					<dl className="space-y-1">
						<div>
							<dt className="text-muted-foreground">Name</dt>
							<dd className="break-all font-mono text-xs select-all">{domain.proof.name}</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Value</dt>
							<dd className="break-all font-mono text-xs select-all">{domain.proof.value}</dd>
						</div>
					</dl>
				</div>
			)}
			{admin ? (
				<div className="flex flex-wrap items-center gap-2">
					<Label htmlFor={`sends-with-${domain.id}`} className="text-muted-foreground">
						Sends with
					</Label>
					<select
						id={`sends-with-${domain.id}`}
						value={domain.sendsWith}
						disabled={switching}
						onChange={(event) => {
							const chosen = event.target.value;
							if (chosen === "cloudflare" || chosen === "resend") void sendWith(chosen);
						}}
						className="h-9 min-w-0 rounded-md border bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<option value="cloudflare">{SENDS_WITH_WORDS.cloudflare}</option>
						<option value="resend" disabled={keyed === false && domain.sendsWith !== "resend"}>
							{keyed === false ? "Resend (add a key first)" : SENDS_WITH_WORDS.resend}
						</option>
					</select>
				</div>
			) : (
				<p className="text-sm text-muted-foreground">
					Sends with {SENDS_WITH_WORDS[domain.sendsWith]}
				</p>
			)}
			{admin ? (
				<div className="flex flex-wrap items-center gap-2">
					<Label htmlFor={`receives-with-${domain.id}`} className="text-muted-foreground">
						Receives with
					</Label>
					<select
						id={`receives-with-${domain.id}`}
						value={domain.receivesWith}
						disabled={switching}
						onChange={(event) => {
							const chosen = event.target.value;
							if (chosen === "cloudflare" || chosen === "resend") void receiveWith(chosen);
						}}
						className="h-9 min-w-0 rounded-md border bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<option value="cloudflare">{RECEIVES_WITH_WORDS.cloudflare}</option>
						<option value="resend" disabled={keyed === false && domain.receivesWith !== "resend"}>
							{keyed === false ? "Resend (add a key first)" : RECEIVES_WITH_WORDS.resend}
						</option>
					</select>
				</div>
			) : (
				<p className="text-sm text-muted-foreground">
					Receives with {RECEIVES_WITH_WORDS[domain.receivesWith]}
				</p>
			)}
			{admin && domain.verifiedAt !== null && domain.sendsWith === "cloudflare" && (
				<p className="text-sm text-muted-foreground">
					{domain.eventsAt === null
						? "No delivery events from Email Service yet. They come once whoever runs this deployment subscribes its queue to this domain, as the self-hosting guide shows, and something is sent."
						: `Email Service's delivery events last came ${formatRelative(domain.eventsAt)}.`}
				</p>
			)}
			{admin &&
				domain.verifiedAt !== null &&
				domain.sendsWith === "resend" &&
				keyed !== false &&
				(webhookReady || domain.eventsAt !== null) && (
					<p className="text-sm text-muted-foreground">
						{domain.eventsAt === null
							? "No delivery events from Resend yet. They come through the workspace's webhook once something is sent."
							: `Resend's delivery events last came ${formatRelative(domain.eventsAt)}.`}
					</p>
				)}
			{admin && domain.sendsWith === "resend" && keyed === false && (
				<p className="text-sm text-destructive">
					This domain sends through Resend, and the workspace has no Resend key, so its mail can't
					be sent. Add a key below, or send with Cloudflare Email Service.
				</p>
			)}
			{said && (
				<p role="status" className="text-sm text-muted-foreground">
					{said}
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{admin && (
				<div className="flex flex-wrap gap-2">
					<LiveButton size="sm" variant="outline" disabled={pending} onClick={check}>
						{pending ? "Checking…" : "Check DNS"}
					</LiveButton>
					<Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
						Remove
					</Button>
				</div>
			)}
			{removing && (
				<ConfirmDialog
					title={`Remove ${domain.name}?`}
					confirmLabel="Remove domain"
					onConfirm={remove}
					onClose={() => setRemoving(false)}
				>
					Its addresses go with it, and mail to them is refused from then on.
				</ConfirmDialog>
			)}
		</li>
	);
}
