import { and, eq } from "drizzle-orm";
import { DEFAULT_SEND_PER_DAY, readAllowed } from "../../lib/agent-policy";
import { type Database, schema } from "../db";

/** URL parses the authority, including IDN and IPv6, without treating userinfo or port as the host. */
export const webhookHost = (url: string) => new URL(url).hostname.toLowerCase().replace(/\.$/, "");

/**
 * Only the workspace object has the old URLs. Before it accepts a new one, merge the hosts it
 * already knows into D1 once. A concurrent settings save or migration wins over this snapshot.
 */
export async function webhookTargets(
	db: Database,
	workspaceId: string,
	memberId: string,
	oldUrls: () => string[],
): Promise<string[] | null> {
	const { agentPolicy } = schema;
	const find = () => db.select().from(agentPolicy).where(eq(agentPolicy.memberId, memberId)).get();
	let row = await find();
	while (!row?.webhookHostsSeeded) {
		const previous = readAllowed(row?.webhookHosts ?? "[]");
		const hosts = oldUrls()
			.filter((url) => URL.canParse(url))
			.map(webhookHost);
		const entries = [...new Set([...previous, ...hosts])];
		const webhookHosts = JSON.stringify(entries);
		const write = row
			? db
					.update(agentPolicy)
					.set({ webhookHosts, webhookHostsSeeded: true })
					.where(
						and(
							eq(agentPolicy.memberId, memberId),
							eq(agentPolicy.webhookHostsSeeded, false),
							eq(agentPolicy.webhookHosts, row.webhookHosts),
						),
					)
			: db
					.insert(agentPolicy)
					.values({
						memberId,
						allowed: "[]",
						webhookHosts,
						sendPerDay: DEFAULT_SEND_PER_DAY,
						updatedAt: new Date(),
						webhookHostsSeeded: true,
					})
					.onConflictDoNothing();
		const added = entries.filter((entry) => !previous.includes(entry));
		const update = write.returning().toSQL();
		const statements = [db.$client.prepare(update.sql).bind(...update.params)];
		if (added.length) {
			// If a competing write won, changes() is zero. If the audit fails, the seed rolls back.
			statements.push(
				db.$client
					.prepare(
						`INSERT INTO agent_log (id, organization_id, agent_member_id, by_agent, action, detail, at)
				SELECT ?, ?, ?, 1, 'webhook.hosts-seeded', ?, ? WHERE changes() = 1`,
					)
					.bind(crypto.randomUUID(), workspaceId, memberId, added.join(", "), Date.now()),
			);
		}
		const [result] = await db.$client.batch<{ any_recipient: number }>(statements);
		const saved = result?.results[0];
		if (saved) return saved.any_recipient ? null : entries;
		row = await find();
	}
	return row.anyRecipient ? null : readAllowed(row.webhookHosts);
}
