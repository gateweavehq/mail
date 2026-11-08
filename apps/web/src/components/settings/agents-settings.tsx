// Ported from Gateweave Track's agent settings (apps/web/src/components/settings/agents-settings.tsx).
import { Link, useRouter } from "@tanstack/react-router";
import { Bot, Copy, Ellipsis, KeyRound, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
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
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { useWorkspace } from "#/components/workspace/context";
import type { AgentInfo, AgentKeyInfo } from "#/lib/agents";
import { authClient } from "#/lib/auth-client";
import { formatDateTime, formatRelative, formatShortDate } from "#/lib/dates";

/** What to say about a refusal, where the server's own words are not for people. */
function failure(
	error: { code?: string | undefined; message?: string | undefined },
	fallback: string,
) {
	if (error.code === "SESSION_NOT_FRESH") {
		return "Making a key needs a recent sign-in. Sign out and sign in again, then try again.";
	}
	return error.message || fallback;
}

/** A key just made, shown once. */
interface NewKey {
	agentName: string;
	secret: string;
}

export function AgentsSettings({
	admin,
	agents,
	apiUrl,
}: {
	admin: boolean;
	agents: AgentInfo[];
	/** Where the API is, such as `https://mail.example.com/api`. */
	apiUrl: string;
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
					reads mail through the API with a key, and only the mailboxes it is given: opening a
					mailbox to everyone doesn't open it to agents. It never signs in, and it cannot change the
					workspace.
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
							<AgentRow key={agent.id} agent={agent} onNewKey={setNewKey} />
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
	const { slug } = useWorkspace();
	async function copy(text: string, what: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(`${what} copied`);
		} catch {
			toast.error(`Could not copy the ${what.toLowerCase()}`);
		}
	}
	const command = `curl -H "Authorization: Bearer ${newKey.secret}" ${apiUrl}/directory/${slug}`;

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
					The agent sends the key as{" "}
					<code className="font-mono text-xs text-foreground">Authorization: Bearer …</code>. This
					lists the mailboxes it was given; each one's mail is at{" "}
					<code className="font-mono text-xs text-foreground break-all">
						{apiUrl}/mail/{slug}/&lt;mailbox&gt;
					</code>
					.
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

function AgentRow({ agent, onNewKey }: { agent: AgentInfo; onNewKey: (key: NewKey) => void }) {
	const router = useRouter();
	const [action, setAction] = useState<"rename" | "delete" | null>(null);
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
			<div className="flex items-center gap-3">
				<Bot
					aria-hidden
					className="size-8 shrink-0 rounded-full border p-1.5 text-muted-foreground"
				/>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">{agent.name}</p>
					<p className="text-xs text-muted-foreground">
						Created {formatShortDate(agent.createdAt)}
					</p>
				</div>
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
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => setAction("delete")}
						>
							Delete agent
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
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
		</li>
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
