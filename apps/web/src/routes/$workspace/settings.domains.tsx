import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdminRole, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import {
	changeDirectory,
	type DirectoryDomain,
	getDirectory,
	type MailRoute,
} from "#/lib/directory";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/domains")({
	loader: ({ params }) => getDirectory({ data: params.workspace }),
	component: DomainsPage,
});

function DomainsPage() {
	const data = Route.useLoaderData();
	const admin = isAdminRole(useMyRole());
	useDocumentTitle("Domains");

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
				{data.domains.length > 0 && (
					<ul aria-label="Domains" className="space-y-3">
						{data.domains.map((domain) => (
							<DomainRow key={domain.id} domain={domain} admin={admin} />
						))}
					</ul>
				)}
			</section>

			<section aria-labelledby="routing-heading" className="space-y-3">
				<h2 id="routing-heading" className="text-sm font-semibold">
					Getting a domain's mail to this server
				</h2>
				<p className="text-sm text-muted-foreground">
					Mail can't send or reply yet, so think before doing this for a domain people rely on: its
					mail is kept here and shown, and a message to an address that doesn't exist is refused.
				</p>
				<p className="text-sm text-muted-foreground">
					In the Cloudflare account that runs this server, turn on Email Routing for the domain you
					proved. Then choose one of these:
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
function checkedWords(proved: boolean, mail: MailRoute): string {
	if (!proved) return "No matching TXT record yet. A new one can take a few minutes to show.";
	if (mail === "cloudflare") {
		return "Proved. Its MX records point to Cloudflare, which is right if this server's account runs it.";
	}
	if (mail === "elsewhere") {
		return "Proved, but not all its MX records point to Cloudflare, so some or all of its mail won't reach this server.";
	}
	return "Proved, but it has no MX records yet. Turning on Email Routing adds them.";
}

function DomainRow({ domain, admin }: { domain: DirectoryDomain; admin: boolean }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [said, setSaid] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [removing, setRemoving] = useState(false);

	async function check() {
		setPending(true);
		setError(null);
		setSaid(null);
		const result = await changeDirectory<{ proved: boolean; mail: MailRoute }>(slug, {
			action: "check-domain",
			id: domain.id,
		});
		if (result.ok) {
			setSaid(checkedWords(result.proved, result.mail));
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
