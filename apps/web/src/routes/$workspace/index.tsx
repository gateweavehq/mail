import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdminRole, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatShortDate } from "#/lib/dates";
import {
	changeDirectory,
	type DirectoryDomain,
	type DirectoryMailbox,
	getDirectory,
} from "#/lib/directory";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/")({
	loader: ({ params }) => getDirectory({ data: params.workspace }),
	component: WorkspaceHome,
});

function WorkspaceHome() {
	const { name, slug } = useWorkspace();
	const admin = isAdminRole(useMyRole());
	const data = Route.useLoaderData();
	useDocumentTitle("Home");

	if (!data) {
		return (
			<div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
				<Notice title="Mailboxes unavailable">You are no longer a member of this workspace.</Notice>
			</div>
		);
	}

	const proved = data.domains.filter((domain) => domain.verifiedAt);

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">{name}</h1>
			</header>

			{data.mailboxes.length === 0 && (
				<section className="space-y-3 rounded-lg border p-6">
					<h2 className="text-sm font-medium">No mailboxes yet</h2>
					<p className="text-sm text-muted-foreground">
						A mailbox gets its mail through addresses on a domain this workspace has proved.
					</p>
					{admin ? (
						<Button asChild size="sm" variant="outline">
							<Link
								to="/$workspace/settings/members"
								params={{ workspace: slug }}
								search={{ invite: true }}
							>
								Invite people
							</Link>
						</Button>
					) : (
						<p className="text-sm text-muted-foreground">
							An owner or admin can make one, or invite people.
						</p>
					)}
				</section>
			)}

			<p className="text-sm text-muted-foreground">
				Gateweave Mail is early: it can't store mail yet. A message to an address here is told to
				try again later, and one to any other address is refused.
			</p>

			{admin && <AddMailbox />}

			{data.mailboxes.length > 0 && (
				<ul aria-label="Mailboxes" className="space-y-4">
					{data.mailboxes.map((box) => (
						<MailboxCard key={box.id} box={box} domains={proved} admin={admin} />
					))}
				</ul>
			)}
		</div>
	);
}

function AddMailbox() {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const result = await changeDirectory(slug, { action: "add-mailbox", name });
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
				<Label htmlFor="mailbox-name">New mailbox</Label>
				<Input
					id="mailbox-name"
					autoComplete="off"
					placeholder="Support"
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
				{pending ? "Making…" : "Make mailbox"}
			</LiveButton>
		</form>
	);
}

function MailboxCard({
	box,
	domains,
	admin,
}: {
	box: DirectoryMailbox;
	domains: DirectoryDomain[];
	admin: boolean;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function act(action: Parameters<typeof changeDirectory>[1]) {
		setError(null);
		const result = await changeDirectory(slug, action);
		if (result.ok) {
			await router.invalidate();
		} else {
			setError(result.error);
		}
	}

	return (
		<li className="space-y-3 rounded-lg border p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="min-w-0 break-words text-sm font-medium">{box.name}</h2>
				{admin && (
					<Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
						Remove
					</Button>
				)}
			</div>

			{box.addresses.length > 0 ? (
				<ul aria-label={`Addresses of ${box.name}`} className="space-y-1">
					{box.addresses.map((address) => (
						<li key={address.id} className="flex flex-wrap items-center justify-between gap-2">
							<span className="min-w-0 break-all font-mono text-xs">{address.address}</span>
							<span className="flex items-center gap-2 text-sm text-muted-foreground">
								{address.expiresAt && <AddressEnd time={address.expiresAt} />}
								{admin && (
									<Button
										size="sm"
										variant="ghost"
										aria-label={`Remove ${address.address}`}
										onClick={() => act({ action: "remove-address", id: address.id })}
									>
										Remove
									</Button>
								)}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-muted-foreground">No addresses yet.</p>
			)}

			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}

			{admin && <AddAddress box={box} domains={domains} />}

			{removing && (
				<ConfirmDialog
					title={`Remove ${box.name}?`}
					confirmLabel="Remove mailbox"
					onConfirm={async () => {
						await act({ action: "remove-mailbox", id: box.id });
						setRemoving(false);
					}}
					onClose={() => setRemoving(false)}
				>
					Its addresses go with it, and mail to them is refused from then on.
				</ConfirmDialog>
			)}
		</li>
	);
}

function AddressEnd({ time }: { time: number }) {
	return <span>{time > Date.now() ? `Ends ${formatShortDate(time)}` : "Ended"}</span>;
}

const LIFETIMES = [
	{ label: "For good", days: null },
	{ label: "1 day", days: 1 },
	{ label: "7 days", days: 7 },
	{ label: "30 days", days: 30 },
] as const;

const FIELD =
	"h-9 w-full rounded-md border bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function AddAddress({ box, domains }: { box: DirectoryMailbox; domains: DirectoryDomain[] }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [localPart, setLocalPart] = useState("");
	const [domainId, setDomainId] = useState<string | null>(null);
	const [lifetime, setLifetime] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	if (domains.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				To give it an address,{" "}
				<Link
					to="/$workspace/settings/domains"
					params={{ workspace: slug }}
					className="underline underline-offset-4"
				>
					prove a domain
				</Link>{" "}
				first.
			</p>
		);
	}

	const chosen = domains.find((domain) => domain.id === domainId) ?? domains[0];

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!chosen) return;
		setPending(true);
		setError(null);
		const result = await changeDirectory(slug, {
			action: "add-address",
			domainId: chosen.id,
			mailboxId: box.id,
			localPart,
			expiresInDays: LIFETIMES[lifetime]?.days ?? null,
		});
		if (result.ok) {
			setLocalPart("");
			await router.invalidate();
		} else {
			setError(result.error);
		}
		setPending(false);
	}

	return (
		<form onSubmit={onSubmit} className="space-y-3 border-t pt-3">
			<div className="grid gap-3 sm:grid-cols-3">
				<div className="space-y-2">
					<Label htmlFor={`local-part-${box.id}`}>New address</Label>
					<Input
						id={`local-part-${box.id}`}
						autoComplete="off"
						spellCheck={false}
						placeholder="support"
						value={localPart}
						onChange={(event) => setLocalPart(event.target.value)}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`domain-${box.id}`}>At</Label>
					<select
						id={`domain-${box.id}`}
						className={FIELD}
						value={chosen?.id}
						onChange={(event) => setDomainId(event.target.value)}
					>
						{domains.map((domain) => (
							<option key={domain.id} value={domain.id}>
								{domain.name}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`lifetime-${box.id}`}>How long</Label>
					<select
						id={`lifetime-${box.id}`}
						className={FIELD}
						value={lifetime}
						onChange={(event) => setLifetime(Number(event.target.value))}
					>
						{LIFETIMES.map((option, index) => (
							<option key={option.label} value={index}>
								{option.label}
							</option>
						))}
					</select>
				</div>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<LiveButton type="submit" size="sm" variant="outline" disabled={pending || !localPart.trim()}>
				{pending ? "Adding…" : "Add address"}
			</LiveButton>
		</form>
	);
}
