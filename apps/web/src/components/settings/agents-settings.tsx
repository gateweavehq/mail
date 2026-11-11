// Ported from Gateweave Track's agent settings (apps/web/src/components/settings/agents-settings.tsx).
import { Link, useRouter } from "@tanstack/react-router";
import { AtSign, Bot, Copy, Ellipsis, KeyRound, Pause, Play, Plus, Send } from "lucide-react";
import { type FormEvent, useState } from "react";
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
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { useWorkspace } from "#/components/workspace/context";
import {
	addressPolicySummary,
	MAX_AGENT_ADDRESS_DAYS,
	MAX_AGENT_LIVE_ADDRESSES,
} from "#/lib/agent-addresses";
import {
	MAX_AGENT_SEND_PER_DAY,
	MAX_ALLOWED_ENTRIES,
	policySummary,
	typedAllowed,
} from "#/lib/agent-policy";
import type { AgentInfo, AgentKeyInfo } from "#/lib/agents";
import { authClient } from "#/lib/auth-client";
import { formatDateTime, formatRelative, formatShortDate } from "#/lib/dates";

/** What to say about a refusal, where the server's own words are not for people. */
function failure(
	error: { code?: string | undefined; message?: string | undefined },
	fallback: string,
) {
	if (error.code === "SESSION_NOT_FRESH") {
		return "This needs a recent sign-in. Sign out and sign in again, then try again.";
	}
	return error.message || fallback;
}

/** The skill for agents, as plain Markdown, which the plugin carries too. */
const SKILL_URL =
	"https://github.com/gateweavehq/mail/blob/main/plugins/gateweave-mail/skills/mail/SKILL.md";

/** A key just made, shown once. */
interface NewKey {
	agentName: string;
	secret: string;
}

export function AgentsSettings({
	admin,
	agents,
	apiUrl,
	domains,
}: {
	admin: boolean;
	agents: AgentInfo[];
	/** Where the API is, such as `https://mail.example.com/api`. */
	apiUrl: string;
	/** The workspace's proved domains, which an agent may be let make addresses on. */
	domains: string[];
}) {
	const { slug } = useWorkspace();
	const [newKey, setNewKey] = useState<NewKey | null>(null);
	return (
		<section aria-labelledby="agents-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="agents-heading" className="text-base font-semibold">
					Agents
				</h2>
				<p className="text-sm text-muted-foreground">
					An agent is a member for an AI agent, such as one that sorts what arrives at support. It
					reads mail over MCP or the API with a key, and only the mailboxes it is given: opening a
					mailbox to everyone doesn't open it to agents. A mailbox can let it send too: what it
					writes to the addresses its settings here allow goes on its own, and anything else waits
					for a person to approve it. It never signs in, and it cannot change the workspace.
					{admin ? (
						<>
							{" "}
							Give it a mailbox from the mailbox's card on the{" "}
							<Link to="/$workspace" params={{ workspace: slug }} className="underline">
								workspace's home
							</Link>
							.
						</>
					) : (
						" Owners and admins make agents and their keys."
					)}
				</p>
			</div>
			{admin && <CreateAgentForm onCreated={setNewKey} />}
			{newKey && <KeyReveal newKey={newKey} apiUrl={apiUrl} onDone={() => setNewKey(null)} />}
			{admin &&
				(agents.length === 0 ? (
					<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
						No agents yet.
					</p>
				) : (
					<ul aria-label="Agents" className="divide-y rounded-lg border">
						{agents.map((agent) => (
							<AgentRow key={agent.id} agent={agent} domains={domains} onNewKey={setNewKey} />
						))}
					</ul>
				))}
		</section>
	);
}

function CreateAgentForm({ onCreated }: { onCreated: (key: NewKey) => void }) {
	const { id: organizationId } = useWorkspace();
	const router = useRouter();
	const [name, setName] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const result = await authClient.agents.create({ organizationId, name: name.trim() });
		setPending(false);
		if (result.error || !result.data) {
			setError(failure(result.error ?? {}, "Could not create the agent"));
			return;
		}
		onCreated({ agentName: result.data.agent.name, secret: result.data.key });
		setName("");
		await router.invalidate();
	}

	return (
		<div className="space-y-2">
			<form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
				<Input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Support sorter"
					aria-label="Agent name"
					maxLength={80}
					required
					className="sm:flex-1"
				/>
				<Button type="submit" disabled={pending || !name.trim()}>
					<Plus />
					Create agent
				</Button>
			</form>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}

function KeyReveal({
	newKey,
	apiUrl,
	onDone,
}: {
	newKey: NewKey;
	apiUrl: string;
	onDone: () => void;
}) {
	async function copy(text: string, what: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(`${what} copied`);
		} catch {
			toast.error(`Could not copy the ${what.toLowerCase()}`);
		}
	}
	const mcpUrl = new URL("/mcp", apiUrl).href;
	// The key isn't in it: Claude Code asks for it, and keeps it with its own sign-in.
	const pluginCommand = `claude plugin install gateweave-mail --marketplace gateweavehq/mail --config mcp_url=${mcpUrl}`;
	const restUrl = `${apiUrl}/v1`;
	const command = `curl -H "Authorization: Bearer ${newKey.secret}" ${restUrl}/mailboxes`;

	return (
		<div className="space-y-3 rounded-lg border bg-muted/40 p-3" aria-live="polite">
			<p className="text-sm">
				Copy the key for <span className="font-medium">{newKey.agentName}</span> now. Mail keeps
				only a hash of it, so it is never shown again.
			</p>
			<div className="flex gap-2">
				<Input
					readOnly
					value={newKey.secret}
					aria-label="Agent key"
					onFocus={(event) => event.currentTarget.select()}
					className="font-mono text-xs"
				/>
				<Button variant="outline" onClick={() => copy(newKey.secret, "Key")}>
					<Copy />
					Copy
				</Button>
			</div>
			<div className="space-y-2 text-sm text-muted-foreground">
				<p>
					The agent's MCP client connects to{" "}
					<code className="font-mono text-xs text-foreground break-all">{mcpUrl}</code> and sends
					the key as{" "}
					<code className="font-mono text-xs text-foreground">Authorization: Bearer …</code>. Its
					tools read and wait for mail, give sign-in codes, send and make addresses, as this agent
					may.
				</p>
				<p>
					In Claude Code, Mail's plugin adds them, with a{" "}
					<a
						href={SKILL_URL}
						target="_blank"
						rel="noreferrer"
						className="text-foreground underline underline-offset-4"
					>
						skill
					</a>{" "}
					that says how to use them well, which other agents can follow too. Install it with:
				</p>
				<div className="flex items-start gap-2">
					<pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background p-2 font-mono text-xs text-foreground">
						{pluginCommand}
					</pre>
					<Button
						variant="ghost"
						size="icon"
						className="size-8"
						aria-label="Copy the plugin command"
						onClick={() => copy(pluginCommand, "Command")}
					>
						<Copy />
					</Button>
				</div>
				<p>
					Then run{" "}
					<code className="font-mono text-xs text-foreground">
						/plugin configure gateweave-mail@gateweave-mail
					</code>{" "}
					in Claude Code and paste the key. Claude Code keeps it with its own sign-in, not in its
					settings.
				</p>
				<p>
					Or its own code calls the API at{" "}
					<code className="font-mono text-xs text-foreground break-all">{restUrl}</code> with the
					same header, for what the tools do. This lists the mailboxes it was given; the{" "}
					<a
						href={`${restUrl}/openapi.json`}
						target="_blank"
						rel="noreferrer"
						className="text-foreground underline underline-offset-4"
					>
						OpenAPI document
					</a>{" "}
					describes the rest.
				</p>
				<div className="flex items-start gap-2">
					<pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background p-2 font-mono text-xs text-foreground">
						{command}
					</pre>
					<Button
						variant="ghost"
						size="icon"
						className="size-8"
						aria-label="Copy the command"
						onClick={() => copy(command, "Command")}
					>
						<Copy />
					</Button>
				</div>
			</div>
			<Button variant="outline" size="sm" onClick={onDone}>
				Done
			</Button>
		</div>
	);
}

/**
 * Pause an agent, or resume one that is paused. Paused, its keys stop working and its mail
 * waiting to be tried again goes to a person.
 */
export function PauseButton({ agent }: { agent: Pick<AgentInfo, "id" | "name" | "paused"> }) {
	const router = useRouter();
	const [pausing, setPausing] = useState(false);

	async function change(pause: boolean) {
		setPausing(true);
		const result = pause
			? await authClient.agents.pause({ agentId: agent.id })
			: await authClient.agents.resume({ agentId: agent.id });
		setPausing(false);
		if (result.error) {
			toast.error(`Could not ${pause ? "pause" : "resume"} ${agent.name}`, {
				description: failure(result.error, "Something went wrong"),
			});
			return;
		}
		toast.success(pause ? `${agent.name} is paused` : `${agent.name} runs again`);
		await router.invalidate();
	}

	if (agent.paused) {
		return (
			<Button variant="outline" size="sm" disabled={pausing} onClick={() => change(false)}>
				<Play />
				Resume
			</Button>
		);
	}
	return (
		<>
			<Button
				variant="outline"
				size="sm"
				disabled={pausing}
				onClick={() => change(true)}
				aria-describedby={`pause-${agent.id}`}
			>
				<Pause />
				Pause
			</Button>
			<span id={`pause-${agent.id}`} hidden>
				Its keys stop working until someone resumes it, and its mail waiting to be tried again goes
				to a person.
			</span>
		</>
	);
}

/** Who paused an agent and when, and what that means while it lasts. */
export function PausedNote({
	paused,
	className = "",
}: {
	paused: NonNullable<AgentInfo["paused"]>;
	className?: string;
}) {
	return (
		<p className={`text-xs font-medium ${className}`}>
			<span title={formatDateTime(paused.at)}>
				Paused {paused.by ? `by ${paused.by} ` : ""}
				{formatRelative(paused.at)}.
			</span>{" "}
			<span className="font-normal text-muted-foreground">
				Its keys do nothing until it is resumed. What it wrote that waited to be tried again waits
				for a person to approve it, and its own webhooks hear nothing. Mail to its addresses still
				arrives.
			</span>
		</p>
	);
}

function AgentRow({
	agent,
	domains,
	onNewKey,
}: {
	agent: AgentInfo;
	domains: string[];
	onNewKey: (key: NewKey) => void;
}) {
	const router = useRouter();
	const { slug } = useWorkspace();
	const [action, setAction] = useState<"rename" | "sending" | "addresses" | "delete" | null>(null);
	const [revoking, setRevoking] = useState<AgentKeyInfo | null>(null);

	async function newKey() {
		const result = await authClient.agents.createKey({ agentId: agent.id });
		if (result.error || !result.data) {
			toast.error("Could not make a key", {
				description: failure(result.error ?? {}, "Something went wrong"),
			});
			return;
		}
		onNewKey({ agentName: agent.name, secret: result.data.secret });
		await router.invalidate();
	}

	async function revoke(key: AgentKeyInfo) {
		const result = await authClient.agents.revokeKey({ keyId: key.id });
		if (result.error) {
			toast.error("Could not revoke the key", { description: result.error.message });
			return;
		}
		toast.success(`Key ${key.start}… revoked`);
		await router.invalidate();
	}

	async function remove() {
		const result = await authClient.agents.delete({ agentId: agent.id });
		if (result.error) {
			toast.error(`Could not delete ${agent.name}`, { description: result.error.message });
			return;
		}
		toast.success(`${agent.name} was deleted`);
		await router.invalidate();
	}

	return (
		<li className="space-y-2 px-4 py-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<Bot
					aria-hidden
					className="size-8 shrink-0 rounded-full border p-1.5 text-muted-foreground"
				/>
				<div className="min-w-0 flex-1 basis-48">
					<p className="truncate text-sm font-medium">
						<Link
							to="/$workspace/settings/agents/$agent"
							params={{ workspace: slug, agent: agent.id }}
							className="hover:underline hover:underline-offset-4"
						>
							{agent.name}
						</Link>
					</p>
					<p className="text-xs text-muted-foreground">
						Created {formatShortDate(agent.createdAt)}
					</p>
					<p className="text-xs text-muted-foreground">{policySummary(agent.policy)}</p>
					<p className="text-xs text-muted-foreground">
						{addressPolicySummary(agent.addressPolicy)}
						{agent.liveAddresses > 0 && ` Holds ${agent.liveAddresses} now.`}
					</p>
				</div>
				<PauseButton agent={agent} />
				<Button variant="outline" size="sm" onClick={newKey}>
					<KeyRound />
					New key
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-8"
							aria-label={`More for ${agent.name}`}
						>
							<Ellipsis />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => setAction("rename")}>Rename</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => setAction("sending")}>
							<Send />
							Sending
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => setAction("addresses")}>
							<AtSign />
							Addresses
						</DropdownMenuItem>
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => setAction("delete")}
						>
							Delete agent
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{agent.paused && <PausedNote paused={agent.paused} className="pl-11" />}
			{agent.keys.length === 0 ? (
				<p className="pl-11 text-xs text-muted-foreground">
					No keys. It can't read anything until you make one.
				</p>
			) : (
				<ul className="space-y-1 pl-11" aria-label={`Keys of ${agent.name}`}>
					{agent.keys.map((key) => (
						<li key={key.id} className="flex flex-wrap items-center gap-x-3 text-xs">
							<span className="font-mono">{key.start}…</span>
							<span className="text-muted-foreground" title={formatDateTime(key.createdAt)}>
								Made {formatShortDate(key.createdAt)}
							</span>
							<span className="flex-1 text-muted-foreground">
								{key.lastUsedAt === null ? "Never used" : `Used ${formatRelative(key.lastUsedAt)}`}
							</span>
							<Button
								variant="ghost"
								size="sm"
								aria-label={`Revoke key ${key.start}…`}
								onClick={() => setRevoking(key)}
							>
								Revoke
							</Button>
						</li>
					))}
				</ul>
			)}
			{revoking && (
				<ConfirmDialog
					title={`Revoke key ${revoking.start}…?`}
					confirmLabel="Revoke"
					onConfirm={() => revoke(revoking)}
					onClose={() => setRevoking(null)}
				>
					Whatever uses it loses access right away. {agent.name}'s other keys keep working.
				</ConfirmDialog>
			)}
			{action === "delete" && (
				<ConfirmDialog
					title={`Delete ${agent.name}?`}
					confirmLabel="Delete"
					onConfirm={remove}
					onClose={() => setAction(null)}
				>
					Its keys stop working right away, and the mailboxes it was given are no longer its.
				</ConfirmDialog>
			)}
			{action === "rename" && <RenameAgentDialog agent={agent} onClose={() => setAction(null)} />}
			{action === "sending" && <PolicyDialog agent={agent} onClose={() => setAction(null)} />}
			{action === "addresses" && (
				<AddressPolicyDialog agent={agent} domains={domains} onClose={() => setAction(null)} />
			)}
		</li>
	);
}

/** How much an agent may send, and to whom without approval. */
function PolicyDialog({ agent, onClose }: { agent: AgentInfo; onClose: () => void }) {
	const router = useRouter();
	const [perDay, setPerDay] = useState(String(agent.policy.sendPerDay));
	const [allowed, setAllowed] = useState(agent.policy.allowed.join("\n"));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		const sendPerDay = Number(perDay);
		if (!Number.isInteger(sendPerDay) || sendPerDay < 0 || sendPerDay > MAX_AGENT_SEND_PER_DAY) {
			setError(`A day's mail is a whole number from 0 to ${MAX_AGENT_SEND_PER_DAY}.`);
			return;
		}
		const entries = typedAllowed(allowed);
		if (entries.length > MAX_ALLOWED_ENTRIES) {
			setError(`List up to ${MAX_ALLOWED_ENTRIES} addresses and domains.`);
			return;
		}
		setPending(true);
		setError(null);
		const result = await authClient.agents.setPolicy({
			agentId: agent.id,
			sendPerDay,
			allowed: entries,
		});
		setPending(false);
		if (result.error) {
			setError(
				failure(
					result.error,
					"Those weren't saved. Each line is an address, such as ops@example.com, or a domain after an @, such as @example.com.",
				),
			);
			return;
		}
		onClose();
		await router.invalidate();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="wrap-anywhere">What {agent.name} can send</DialogTitle>
					<DialogDescription>
						It sends only from mailboxes that let it. Mail to anyone not listed here waits for
						someone who reads the mailbox to approve it.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="agent-per-day">Messages a day</Label>
						<Input
							id="agent-per-day"
							type="number"
							inputMode="numeric"
							min={0}
							max={MAX_AGENT_SEND_PER_DAY}
							step={1}
							value={perDay}
							onChange={(event) => setPerDay(event.target.value)}
							aria-describedby="agent-per-day-help"
							required
						/>
						<p id="agent-per-day-help" className="text-xs text-muted-foreground">
							Counted as it writes them, waiting or not. Changing it doesn't start its day again,
							and 0 stops it sending.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="agent-allowed">Goes without approval to</Label>
						<Textarea
							id="agent-allowed"
							value={allowed}
							onChange={(event) => setAllowed(event.target.value)}
							rows={4}
							placeholder={"ops@example.com\n@example.com"}
							aria-describedby="agent-allowed-help"
						/>
						<p id="agent-allowed-help" className="text-xs text-muted-foreground">
							One a line: an address, or a domain after an @ for anyone there. A message goes on its
							own only when everyone it is to is listed.
						</p>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending}>
							{pending ? "Saving…" : "Save"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** How many addresses an agent may make for itself, for how long, and on which domains. */
function AddressPolicyDialog({
	agent,
	domains,
	onClose,
}: {
	agent: AgentInfo;
	domains: string[];
	onClose: () => void;
}) {
	const router = useRouter();
	const [maxLive, setMaxLive] = useState(String(agent.addressPolicy.maxLive));
	const [maxDays, setMaxDays] = useState(String(agent.addressPolicy.maxDays));
	// A domain no longer proved can't be chosen again, so it drops out when this is saved.
	const [chosen, setChosen] = useState(
		() => new Set(agent.addressPolicy.domains.filter((name) => domains.includes(name))),
	);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function toggle(name: string, on: boolean) {
		setChosen((before) => {
			const after = new Set(before);
			if (on) after.add(name);
			else after.delete(name);
			return after;
		});
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		const live = Number(maxLive);
		if (!Number.isInteger(live) || live < 0 || live > MAX_AGENT_LIVE_ADDRESSES) {
			setError(`How many at once is a whole number from 0 to ${MAX_AGENT_LIVE_ADDRESSES}.`);
			return;
		}
		const days = Number(maxDays);
		if (!Number.isInteger(days) || days < 1 || days > MAX_AGENT_ADDRESS_DAYS) {
			setError(
				`How long each lasts is a whole number of days from 1 to ${MAX_AGENT_ADDRESS_DAYS}.`,
			);
			return;
		}
		setPending(true);
		setError(null);
		const result = await authClient.agents.setAddressPolicy({
			agentId: agent.id,
			maxLive: live,
			maxDays: days,
			domains: [...chosen],
		});
		setPending(false);
		if (result.error) {
			setError(failure(result.error, "Those weren't saved. Try again."));
			return;
		}
		onClose();
		await router.invalidate();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="wrap-anywhere">Addresses {agent.name} can make</DialogTitle>
					<DialogDescription>
						It makes them through the API, such as one for each sign-up, for a mailbox it may send
						from. Each one ends, and mail to it is refused from then on. You can remove any of them
						on the workspace's home.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="agent-max-live">How many at once</Label>
						<Input
							id="agent-max-live"
							type="number"
							inputMode="numeric"
							min={0}
							max={MAX_AGENT_LIVE_ADDRESSES}
							step={1}
							value={maxLive}
							onChange={(event) => setMaxLive(event.target.value)}
							aria-describedby="agent-max-live-help"
							required
						/>
						<p id="agent-max-live-help" className="text-xs text-muted-foreground">
							It can make as many in a day. 0 stops it making more; those it holds keep working.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="agent-max-days">Each lasts at most, in days</Label>
						<Input
							id="agent-max-days"
							type="number"
							inputMode="numeric"
							min={1}
							max={MAX_AGENT_ADDRESS_DAYS}
							step={1}
							value={maxDays}
							onChange={(event) => setMaxDays(event.target.value)}
							required
						/>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">On these domains</legend>
						{domains.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								Prove a domain on the workspace's home first.
							</p>
						) : (
							<ul className="space-y-2">
								{domains.map((name) => {
									const id = `agent-domain-${name}`;
									return (
										<li key={name} className="flex items-center gap-2">
											<Checkbox
												id={id}
												checked={chosen.has(name)}
												onCheckedChange={(checked) => toggle(name, checked === true)}
											/>
											<Label htmlFor={id} className="min-w-0 break-all font-normal">
												{name}
											</Label>
										</li>
									);
								})}
							</ul>
						)}
						<p className="text-xs text-muted-foreground">
							It can't take names such as admin@ or postmaster@, which can prove who runs a domain.
							A domain of its own, such as agents.example.com, keeps its addresses apart from
							people's.
						</p>
					</fieldset>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending}>
							{pending ? "Saving…" : "Save"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function RenameAgentDialog({ agent, onClose }: { agent: AgentInfo; onClose: () => void }) {
	const router = useRouter();
	const [name, setName] = useState(agent.name);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (name.trim() === agent.name) {
			onClose();
			return;
		}
		setPending(true);
		const result = await authClient.agents.update({ agentId: agent.id, name: name.trim() });
		setPending(false);
		if (result.error) {
			setError(result.error.message ?? "Could not rename the agent");
			return;
		}
		onClose();
		await router.invalidate();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="wrap-anywhere">Rename {agent.name}</DialogTitle>
					<DialogDescription>Admins see the new name wherever it is listed.</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="rename-agent">Name</Label>
						<Input
							id="rename-agent"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={80}
							required
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || !name.trim()}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
