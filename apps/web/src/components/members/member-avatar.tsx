import { CircleUserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { cn } from "#/lib/utils";

function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	const first = parts[0]?.[0] ?? "?";
	const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
	return (first + last).toUpperCase();
}

/** A member's picture or initials. Without a member, shows the "unassigned" placeholder. */
export function MemberAvatar({
	member,
	className,
}: {
	member: { name: string; image: string | null } | undefined;
	className?: string;
}) {
	if (!member) {
		return (
			<CircleUserRound
				aria-label="Unassigned"
				className={cn("size-5 shrink-0 text-muted-foreground", className)}
			/>
		);
	}
	return (
		<Avatar className={cn("size-5 text-[10px] font-medium", className)} title={member.name}>
			{member.image && <AvatarImage src={member.image} alt="" draggable={false} />}
			<AvatarFallback>{initials(member.name)}</AvatarFallback>
		</Avatar>
	);
}
