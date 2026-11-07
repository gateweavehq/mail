import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Link, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { Notice } from "#/components/workspace/notice";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Gateweave Mail" },
			{
				name: "description",
				content:
					"Mailboxes for people and agents, on Cloudflare. Early: sign-in and workspaces so far.",
			},
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
		],
	}),
	shellComponent: RootDocument,
	notFoundComponent: NotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Toaster />
				{import.meta.env.DEV && (
					<TanStackDevtools
						config={{ position: "bottom-right" }}
						plugins={[{ name: "TanStack Router", render: <TanStackRouterDevtoolsPanel /> }]}
					/>
				)}
				<Scripts />
			</body>
		</html>
	);
}

function NotFound() {
	return (
		<main className="grid min-h-svh place-items-center">
			<Notice
				title="Page not found"
				action={
					<Button asChild variant="outline">
						<Link to="/">Go to Gateweave Mail</Link>
					</Button>
				}
			>
				Check the address, or start from your workspaces.
			</Notice>
		</main>
	);
}
