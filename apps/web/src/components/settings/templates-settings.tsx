import { useRouter } from "@tanstack/react-router";
import { History, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
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
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { useWorkspace } from "#/components/workspace/context";
import { formatDateTime, formatRelative } from "#/lib/dates";
import {
	MAX_TEMPLATES,
	MAX_VALUE,
	renderTemplate,
	type Template,
	type TemplateContent,
	type TemplateVersion,
	usedVariables,
} from "#/lib/templates";
import {
	type TemplateAction,
	type TemplateAnswer,
	templatesUrl,
	type WorkspaceTemplates,
} from "#/lib/workspace-templates";

/** Sends a change to the workspace's templates, and says what came of it. */
async function change(slug: string, action: TemplateAction): Promise<TemplateAnswer> {
	try {
		const response = await fetch(templatesUrl(slug), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(action),
		});
		return (await response.json()) as TemplateAnswer;
	} catch {
		return { ok: false, error: "Mail didn't answer. Try again." };
	}
}

/** Who saved a version, as the workspace names them now. */
const whoMade = (version: TemplateVersion, people: Record<string, string>) =>
	version.madeBy === null ? "a member who left" : (people[version.madeBy] ?? "a member who left");

/** What the editor starts from, and what it saves again: a template's words. */
interface Draft extends TemplateContent {
	name: string;
}

export function TemplatesSettings({ data, admin }: { data: WorkspaceTemplates; admin: boolean }) {
	const { templates, people } = data;
	// A template being written (null id), or changed, from what it says now or from an old version.
	const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
	const [history, setHistory] = useState<Template | null>(null);
	const [removing, setRemoving] = useState<Template | null>(null);
	const { slug } = useWorkspace();
	const router = useRouter();

	async function remove(template: Template) {
		const result = await change(slug, { action: "remove", id: template.id });
		if (!result.ok) {
			toast.error(result.error);
			return;
		}
		await router.invalidate();
	}

	return (
		<section aria-labelledby="templates-heading" className="space-y-4">
			<div className="flex flex-wrap items-start gap-4">
				<div className="min-w-0 flex-1 space-y-1">
					<h2 id="templates-heading" className="text-base font-semibold">
						Templates
					</h2>
					<p className="text-sm text-muted-foreground">
						A template is a subject and a body written once, with{" "}
						<code className="font-mono text-xs">{"{{name}}"}</code> where a value goes, to send over
						and over: from the mailbox, or by an agent with <code>send_template</code>. The body
						takes the same formatting as a message you write. Values are only ever put in as text,
						so what someone gives for a variable can't add formatting, a link or HTML. Don't put
						secrets in a template: an agent that may send can read one by sending it to itself.{" "}
						{admin
							? "Each time you save, a new version is made, and the old ones stay."
							: "Owners and admins write them."}
					</p>
				</div>
				{admin && (
					<Button
						onClick={() =>
							setEditing({ id: null, draft: { name: "", subject: "", body: "", variables: [] } })
						}
						disabled={templates.length >= MAX_TEMPLATES}
					>
						<Plus />
						Add template
					</Button>
				)}
			</div>
			{templates.length === 0 ? (
				<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
					No templates yet.
				</p>
			) : (
				<ul aria-label="Templates" className="divide-y rounded-lg border">
					{templates.map((template) => (
						<li key={template.id} className="space-y-2 px-4 py-3">
							<div className="flex flex-wrap items-start gap-2">
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-baseline gap-x-2">
										<span className="wrap-anywhere text-sm font-medium">{template.name}</span>
										<span className="text-xs text-muted-foreground">
											version {template.number}, saved by {whoMade(template, people)}{" "}
											<span title={formatDateTime(template.madeAt)}>
												{formatRelative(template.madeAt)}
											</span>
										</span>
									</div>
									<p className="wrap-anywhere text-sm text-muted-foreground">{template.subject}</p>
									{template.variables.length > 0 && (
										<p className="mt-1 flex flex-wrap gap-1">
											{template.variables.map((name) => (
												<code
													key={name}
													className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
												>
													{name}
												</code>
											))}
										</p>
									)}
								</div>
								<div className="flex shrink-0 gap-1">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setHistory(template)}
										aria-label={`Versions of ${template.name}`}
									>
										<History />
										Versions
									</Button>
									{admin && (
										<>
											<Button
												variant="ghost"
												size="sm"
												onClick={() =>
													setEditing({
														id: template.id,
														draft: {
															name: template.name,
															subject: template.subject,
															body: template.body,
															variables: template.variables,
														},
													})
												}
												aria-label={`Edit ${template.name}`}
											>
												<Pencil />
												Edit
											</Button>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setRemoving(template)}
												aria-label={`Remove ${template.name}`}
											>
												<Trash2 />
												Remove
											</Button>
										</>
									)}
								</div>
							</div>
							<details className="text-xs">
								<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
									Body
								</summary>
								<pre className="mt-2 whitespace-pre-wrap break-words rounded-md border p-3 font-sans text-sm">
									{template.body}
								</pre>
							</details>
						</li>
					))}
				</ul>
			)}
			{editing && (
				<TemplateDialog id={editing.id} start={editing.draft} onClose={() => setEditing(null)} />
			)}
			{history && (
				<HistoryDialog
					template={history}
					people={people}
					onUse={
						admin
							? (version) => {
									setHistory(null);
									setEditing({
										id: history.id,
										draft: {
											name: history.name,
											subject: version.subject,
											body: version.body,
											variables: version.variables,
										},
									});
								}
							: undefined
					}
					onClose={() => setHistory(null)}
				/>
			)}
			{removing && (
				<ConfirmDialog
					title={`Remove ${removing.name}?`}
					confirmLabel="Remove"
					onConfirm={() => remove(removing)}
					onClose={() => setRemoving(null)}
				>
					Agents can no longer send it, and its name can be used again. Mail already sent from it
					stays as it was.
				</ConfirmDialog>
			)}
		</section>
	);
}

/** Writes a template, or a new version of one: with what it will look like, from sample values. */
function TemplateDialog({
	id,
	start,
	onClose,
}: {
	id: string | null;
	start: Draft;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const formId = useId();
	const [name, setName] = useState(start.name);
	const [subject, setSubject] = useState(start.subject);
	const [body, setBody] = useState(start.body);
	const [samples, setSamples] = useState<Record<string, string>>({});
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// What the subject and body use is what the template declares: it can't be left out or extra.
	const used = useMemo(() => usedVariables(subject, body), [subject, body]);
	const variables = Array.isArray(used) ? used : [];
	const preview = useMemo(
		() =>
			Array.isArray(used)
				? renderTemplate(
						{ subject, body, variables: used },
						Object.fromEntries(used.map((one) => [one, samples[one]?.trim() || one])),
					)
				: { ok: false as const, error: used },
		[used, subject, body, samples],
	);
	const ready = name.trim() !== "" && subject.trim() !== "" && body.trim() !== "" && preview.ok;

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const result = await change(slug, {
			action: "save",
			id,
			input: { name, subject, body, variables },
		});
		if (!result.ok) {
			setPending(false);
			setError(result.error);
			return;
		}
		try {
			await router.invalidate();
		} finally {
			onClose();
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{id === null ? "Add template" : "Save a new version"}</DialogTitle>
					<DialogDescription>
						Write <code className="font-mono text-xs">{"{{name}}"}</code> where a value goes: lower
						case letters, digits and _. Write <code className="font-mono text-xs">{"\\{{"}</code>{" "}
						for the braces themselves.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor={`${formId}-name`}>Name</Label>
						<Input
							id={`${formId}-name`}
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Welcome"
							maxLength={100}
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${formId}-subject`}>Subject</Label>
						<Input
							id={`${formId}-subject`}
							value={subject}
							onChange={(event) => setSubject(event.target.value)}
							placeholder="Welcome to {{product}}, {{first_name}}"
							maxLength={998}
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${formId}-body`}>Body</Label>
						<Textarea
							id={`${formId}-body`}
							value={body}
							onChange={(event) => setBody(event.target.value)}
							rows={9}
							className="font-mono"
							placeholder={"Hi {{first_name}},\n\nYour code is **{{code}}**."}
							required
						/>
					</div>
					<div className="space-y-2">
						<p className="text-sm font-medium">Variables</p>
						{variables.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								None yet: the subject and body don't use any.
							</p>
						) : (
							<div className="grid gap-2 sm:grid-cols-2">
								{variables.map((variable) => (
									<div key={variable} className="space-y-1">
										<Label htmlFor={`${formId}-v-${variable}`} className="font-mono text-xs">
											{variable}
										</Label>
										<Input
											id={`${formId}-v-${variable}`}
											value={samples[variable] ?? ""}
											onChange={(event) =>
												setSamples((current) => ({ ...current, [variable]: event.target.value }))
											}
											placeholder={`Sample value, ${variable} if left empty`}
											maxLength={MAX_VALUE}
										/>
									</div>
								))}
							</div>
						)}
					</div>
					<div className="space-y-2" aria-live="polite">
						<p className="text-sm font-medium">Preview</p>
						{preview.ok ? (
							<div className="space-y-2 rounded-lg border p-3">
								<p className="wrap-anywhere text-sm">
									<span className="text-muted-foreground">Subject: </span>
									{preview.subject}
								</p>
								{preview.html === null ? (
									<pre className="whitespace-pre-wrap break-words font-sans text-sm">
										{preview.text}
									</pre>
								) : (
									<iframe
										title="The message as it will look"
										// Written by this page from escaped text, and still without scripts or the app's
										// origin, as a message's own HTML is shown.
										sandbox=""
										referrerPolicy="no-referrer"
										srcDoc={`<!doctype html><meta charset="utf-8"><style>:root{color-scheme:light}html{background:#fff;color:#000}body{margin:8px;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;overflow-wrap:break-word}</style>${preview.html}`}
										className="h-48 w-full rounded border bg-white"
									/>
								)}
							</div>
						) : (
							<p role="alert" className="text-sm text-destructive">
								{preview.error}
							</p>
						)}
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
						<Button type="submit" disabled={pending || !ready}>
							{id === null ? "Add template" : "Save version"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** A template's versions, newest first. An admin can start a new one from any of them. */
function HistoryDialog({
	template,
	people,
	onUse,
	onClose,
}: {
	template: Template;
	people: Record<string, string>;
	onUse: ((version: TemplateVersion) => void) | undefined;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const [loaded, setLoaded] = useState<{
		versions: TemplateVersion[];
		people: Record<string, string>;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const response = await fetch(
					`${templatesUrl(slug)}?template=${encodeURIComponent(template.id)}`,
				);
				const body = (await response.json()) as
					| { ok: true; versions: TemplateVersion[]; people: Record<string, string> }
					| { ok: false; error: string };
				if (cancelled) return;
				if (body.ok) setLoaded({ versions: body.versions, people: { ...people, ...body.people } });
				else setError(body.error);
			} catch {
				if (!cancelled) setError("Mail didn't answer. Try again.");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [slug, template.id, people]);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle className="wrap-anywhere">Versions of {template.name}</DialogTitle>
					<DialogDescription>
						A version is never changed. Agents send the latest unless they ask for another by its
						number.
					</DialogDescription>
				</DialogHeader>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{!loaded && !error && <p className="text-sm text-muted-foreground">Loading.</p>}
				{loaded && (
					<ul aria-label="Versions" className="divide-y rounded-lg border">
						{loaded.versions.map((version) => (
							<li key={version.number} className="space-y-2 px-4 py-3">
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-sm font-medium">Version {version.number}</span>
									<span className="min-w-0 flex-1 text-xs text-muted-foreground">
										{whoMade(version, loaded.people)},{" "}
										<span title={formatDateTime(version.madeAt)}>
											{formatRelative(version.madeAt)}
										</span>
									</span>
									{onUse && (
										<Button variant="outline" size="sm" onClick={() => onUse(version)}>
											Start a new version from this
										</Button>
									)}
								</div>
								<p className="wrap-anywhere text-sm">{version.subject}</p>
								<pre className="whitespace-pre-wrap break-words rounded-md border p-3 font-sans text-sm">
									{version.body}
								</pre>
							</li>
						))}
					</ul>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
