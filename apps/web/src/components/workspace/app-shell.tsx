import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
	ArrowLeftRight,
	ChevronDown,
	FileText,
	Inbox,
	LogOut,
	Menu,
	Scale,
	Settings,
	Shield,
	UserPlus,
	UserRound,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { authClient } from "#/lib/auth-client";
import { legalEntries } from "#/lib/legal";
import { cn } from "#/lib/utils";
import { isAdminRole, useMyRole, useWorkspace } from "./context";

export function AppShell({ children }: { children: ReactNode }) {
	const { name } = useWorkspace();
	const [menuOpen, setMenuOpen] = useState(false);
	const pathname = useRouterState({ select: (state) => state.location.pathname });

	// On small screens the sidebar is an overlay; close it once the user has gone somewhere.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on navigation by design.
	useEffect(() => setMenuOpen(false), [pathname]);

	return (
		<div className="flex h-dvh overflow-hidden">
			{menuOpen && (
				<button
					type="button"
					aria-label="Close menu"
					className="fixed inset-0 z-30 bg-black/40 md:hidden"
					onClick={() => setMenuOpen(false)}
				/>
			)}
			<aside
				className={cn(
					"fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r bg-background transition-transform md:static md:w-60 md:translate-x-0",
					menuOpen ? "translate-x-0" : "-translate-x-full",
				)}
			>
				<Sidebar />
			</aside>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:hidden">
					<Button
						variant="ghost"
						size="icon"
						aria-label="Open menu"
						onClick={() => setMenuOpen(true)}
					>
						<Menu />
					</Button>
					<span className="truncate text-sm font-medium">{name}</span>
				</div>
				<main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
			</div>
		</div>
	);
}

const navLink =
	"flex h-8 items-center gap-2 rounded-md px-2 text-sm text-foreground/80 hover:bg-accent hover:text-foreground";
const activeNavLink = "bg-accent font-medium text-foreground";

function Sidebar() {
	const { slug, user } = useWorkspace();

	return (
		<>
			<div className="p-2">
				<WorkspaceMenu />
			</div>
			<nav aria-label="Workspace" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
				<Link
					to="/$workspace"
					params={{ workspace: slug }}
					activeOptions={{ exact: true }}
					className={navLink}
					activeProps={{ className: activeNavLink }}
				>
					<Inbox className="size-4" />
					Mailboxes
				</Link>
				<Link
					to="/$workspace/settings"
					params={{ workspace: slug }}
					className={navLink}
					activeProps={{ className: activeNavLink }}
				>
					<Settings className="size-4" />
					Settings
				</Link>
			</nav>
			<div className="flex items-center gap-2 border-t p-3">
				<MemberAvatar member={user} className="size-6" />
				<p className="min-w-0 flex-1 truncate text-sm">{user.name}</p>
			</div>
		</>
	);
}

const LEGAL_ICONS = { notice: Scale, privacy: Shield, terms: FileText };

function WorkspaceMenu() {
	const { name, slug, legal } = useWorkspace();
	const legalPages = legalEntries(legal);
	const admin = isAdminRole(useMyRole());
	const navigate = useNavigate();

	async function signOut() {
		await authClient.signOut();
		await navigate({ to: "/login" });
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-accent"
				>
					<span className="flex size-5 items-center justify-center rounded bg-primary text-[11px] text-primary-foreground">
						{name.slice(0, 1).toUpperCase()}
					</span>
					<span className="truncate">{name}</span>
					<ChevronDown className="ml-auto size-4 text-muted-foreground" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				<DropdownMenuLabel className="truncate text-xs text-muted-foreground">
					{name}
				</DropdownMenuLabel>
				{admin && (
					<DropdownMenuItem asChild>
						<Link
							to="/$workspace/settings/members"
							params={{ workspace: slug }}
							search={{ invite: true }}
						>
							<UserPlus />
							Invite people
						</Link>
					</DropdownMenuItem>
				)}
				<DropdownMenuItem asChild>
					<Link to="/$workspace/settings" params={{ workspace: slug }}>
						<Settings />
						Settings
					</Link>
				</DropdownMenuItem>
				<DropdownMenuItem asChild>
					<Link to="/">
						<ArrowLeftRight />
						Switch workspace
					</Link>
				</DropdownMenuItem>
				<DropdownMenuItem asChild>
					<Link to="/settings/account">
						<UserRound />
						Your account
					</Link>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				{legalPages.map(({ kind, label, href }) => {
					const Icon = LEGAL_ICONS[kind];
					return (
						<DropdownMenuItem key={kind} asChild>
							<a href={href} target="_blank" rel="noreferrer">
								<Icon />
								{label}
							</a>
						</DropdownMenuItem>
					);
				})}
				{legalPages.length > 0 && <DropdownMenuSeparator />}
				<DropdownMenuItem onSelect={() => void signOut()}>
					<LogOut />
					Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
