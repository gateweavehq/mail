import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { formatDateTime } from "#/lib/dates";
import {
	changeImageSenders,
	type ImageSender,
	type ImageSendersPage,
	imagesUrl,
} from "#/lib/images";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/images")({
	component: ImagesSettings,
});

function ImagesSettings() {
	useDocumentTitle("Images");
	return (
		<section aria-labelledby="images-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="images-heading" className="text-sm font-semibold">
					Images
				</h2>
				<p className="text-sm text-muted-foreground">
					Remote images show by themselves, for you only, in mail proved to come from these domains.
					Loading them tells the sender you opened their message. You add a domain from a message it
					sent, with "Always show images from".
				</p>
			</div>
			<SenderList />
		</section>
	);
}

type Loaded = { ok: true; senders: ImageSender[] } | { ok: false; error: string };

async function load(workspace: string): Promise<Loaded> {
	try {
		const response = await fetch(imagesUrl(workspace));
		const body = (await response.json()) as ImageSendersPage | { ok: false; error: string };
		return "senders" in body ? { ok: true, senders: body.senders } : body;
	} catch {
		return { ok: false, error: "The list didn't load. Try again." };
	}
}

function SenderList() {
	const { slug } = useWorkspace();
	const [senders, setSenders] = useState<ImageSender[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const loaded = await load(slug);
		if (loaded.ok) {
			setSenders(loaded.senders);
			setError(null);
		} else {
			setError(loaded.error);
		}
	}, [slug]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function stop(domain: string) {
		setBusy(domain);
		const answer = await changeImageSenders(slug, { action: "stop", domain });
		setBusy(null);
		if (!answer.ok) {
			setError(answer.error);
			return;
		}
		setSenders((current) => current?.filter((sender) => sender.domain !== domain) ?? null);
	}

	if (senders === null) {
		return error ? (
			<p role="alert" className="text-sm text-destructive">
				{error}
			</p>
		) : (
			<p className="text-sm text-muted-foreground">Loading…</p>
		);
	}
	return (
		<div className="space-y-2">
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{senders.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					None yet: every message's remote images wait until you ask for them.
				</p>
			) : (
				<ul aria-label="Domains whose images show" className="divide-y rounded-lg border">
					{senders.map((sender) => (
						<li key={sender.domain} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3">
							<span className="min-w-0 flex-1 break-all text-sm font-medium">{sender.domain}</span>
							<span className="text-sm text-muted-foreground">
								Since {formatDateTime(sender.allowedAt)}
							</span>
							<Button
								size="sm"
								variant="outline"
								disabled={busy === sender.domain}
								onClick={() => stop(sender.domain)}
								aria-label={`Stop showing images from ${sender.domain}`}
							>
								Stop
							</Button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
