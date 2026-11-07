import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/$workspace/settings")({
	component: SettingsLayout,
});

const TABS = [
	{ to: "/$workspace/settings/members", label: "Members" },
	{ to: "/$workspace/settings/domains", label: "Domains" },
	{ to: "/$workspace/settings/workspace", label: "Workspace" },
] as const;

function SettingsLayout() {
	const { workspace } = Route.useParams();
	return (
		<div className="h-full overflow-y-auto">
			<header className="sticky top-0 z-10 border-b bg-background">
				<div className="mx-auto flex h-12 max-w-3xl items-center gap-6 px-4 sm:px-6">
					<h1 className="text-sm font-medium">Settings</h1>
					{/* On a phone the tabs are wider than the screen, so they scroll sideways. */}
					<nav
						aria-label="Settings"
						className="flex h-full min-w-0 gap-4 overflow-x-auto [scrollbar-width:none]"
					>
						{TABS.map((tab) => (
							<Link
								key={tab.to}
								to={tab.to}
								params={{ workspace }}
								className="flex h-full shrink-0 items-center whitespace-nowrap border-b-2 text-sm"
								activeProps={{ className: "border-foreground text-foreground" }}
								inactiveProps={{
									className: "border-transparent text-muted-foreground hover:text-foreground",
								}}
							>
								{tab.label}
							</Link>
						))}
					</nav>
				</div>
			</header>
			<div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
				<Outlet />
			</div>
		</div>
	);
}
