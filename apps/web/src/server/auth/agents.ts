// Ported from Gateweave Track's agent members (apps/web/src/server/auth/agents.ts).
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	freshSessionMiddleware,
	sessionMiddleware,
} from "better-auth/api";
import { and, asc, count, eq, inArray, isNotNull, like, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import * as z from "zod";
import {
	type AgentAddressPolicy,
	AgentAddressPolicyInput,
	DEFAULT_AGENT_ADDRESS_POLICY,
	readDomains,
} from "../../lib/agent-addresses";
import {
	type AgentPolicy,
	AgentPolicyInput,
	DEFAULT_AGENT_POLICY,
	readAllowed,
} from "../../lib/agent-policy";
import { isAdminRole } from "../../lib/roles";
import type { Database } from "../db";
import { schema } from "../db";
import { liveAddressCounts } from "../directory/agent-address-store";
import { toRole } from "../workspaces";

/**
 * Agent members: users an admin creates for an AI agent, with the `agent` role in one workspace.
 * They have no password and no session, so they never sign in. They read the mail API with a key,
 * and only the mailboxes they are given (`canReadMailbox`): "everyone" never counts them.
 */

export const AGENT_ROLE = "agent";

/**
 * Agents' addresses. `.invalid` can never resolve (RFC 2606), so no mail reaches anyone, and
 * nobody can sign up, sign in or be invited under one.
 */
export const AGENT_EMAIL_DOMAIN = "agents.invalid";

export const MAX_AGENTS_PER_WORKSPACE = 50;
export const MAX_KEYS_PER_AGENT = 5;

/** Mail's own prefix, so a key for another Gateweave product is never tried here. */
export const KEY_PREFIX = "gwm_";
const KEY_PATTERN = /^gwm_[A-Za-z0-9_-]{43}$/;
/** How much of a key is kept to tell keys apart: the prefix and 8 characters, of 47. */
const KEY_START_LENGTH = 12;
/** A key's last use is written at most this often, not on every call. */
const LAST_USED_PRECISION_MS = 5 * 60 * 1000;

/** Whether a membership is an agent's, as stored: one the agents plugin made. */
export function isAgentMembership(role: string): boolean {
	return role.split(",").some((one) => one.trim() === AGENT_ROLE);
}

export function isAgentEmail(email: string): boolean {
	return email.trim().toLowerCase().endsWith(`@${AGENT_EMAIL_DOMAIN}`);
}

/**
 * Whether a member is an agent: the agent's role, on an agent's address, as the agents plugin
 * makes them. A person given the role by hand in the database is still a person, whom the Members
 * page lists and can remove. What they may read and send is still an agent's, the least.
 */
export function isAgentMember({ role, email }: { role: string; email: string }): boolean {
	return isAgentMembership(role) && isAgentEmail(email);
}

/** Whether a bearer token has the shape of an agent key. Says nothing about whether it works. */
export function isAgentKey(token: string): boolean {
	return KEY_PATTERN.test(token);
}

/** A new key: 256 random bits. Only its hash and its first characters are stored. */
async function newKey() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const secret = `${KEY_PREFIX}${btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "")}`;
	return { secret, start: secret.slice(0, KEY_START_LENGTH), hash: await hashKey(secret) };
}

async function hashKey(key: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface AgentByKey {
	keyId: string;
	userId: string;
	workspaceId: string;
	slug: string;
}

/** What a paused agent's key is told, wherever it is used. */
export const AGENT_PAUSED =
	"This agent is paused. An owner or admin of its workspace can resume it, under Agents in the workspace's settings.";

/**
 * The agent a key belongs to, while it is still an agent member of the workspace the key was made
 * for; or that it is paused, when its key does nothing until someone resumes it. Every way in with
 * a key comes through here, so none can miss a pause. Notes the key's use, at most every few
 * minutes, paused or not, so that its page shows an agent still trying.
 */
export async function findAgentByKey(
	db: Database,
	key: string,
): Promise<AgentByKey | { paused: true } | null> {
	if (!isAgentKey(key)) return null;
	const { agentKey, agentPause, member, organization } = schema;
	const row = await db
		.select({
			keyId: agentKey.id,
			userId: agentKey.userId,
			workspaceId: agentKey.organizationId,
			slug: organization.slug,
			lastUsedAt: agentKey.lastUsedAt,
			paused: agentPause.memberId,
		})
		.from(agentKey)
		.innerJoin(
			member,
			and(
				eq(member.userId, agentKey.userId),
				eq(member.organizationId, agentKey.organizationId),
				eq(member.role, AGENT_ROLE),
			),
		)
		.innerJoin(organization, eq(organization.id, agentKey.organizationId))
		.leftJoin(agentPause, eq(agentPause.memberId, member.id))
		.where(eq(agentKey.hash, await hashKey(key)))
		.get();
	if (!row) return null;
	const now = Date.now();
	if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_PRECISION_MS) {
		await db
			.update(agentKey)
			.set({ lastUsedAt: new Date(now) })
			.where(eq(agentKey.id, row.keyId))
			.run();
	}
	if (row.paused !== null) return { paused: true };
	return { keyId: row.keyId, userId: row.userId, workspaceId: row.workspaceId, slug: row.slug };
}

/** Of these memberships, those of agents paused now. At most 100 at once, as D1 binds. */
export async function pausedAmong(db: Database, memberIds: string[]): Promise<Set<string>> {
	if (memberIds.length === 0) return new Set();
	const { agentPause } = schema;
	const rows = await db
		.select({ memberId: agentPause.memberId })
		.from(agentPause)
		.where(inArray(agentPause.memberId, memberIds))
		.all();
	return new Set(rows.map((row) => row.memberId));
}

/**
 * Of these memberships, those whose mail mustn't be tried again by itself: agents paused now, and
 * anyone no longer a member, as an agent deleted while paused takes its pause with it. At most 100
 * at once, as D1 binds.
 */
export async function heldWriters(db: Database, memberIds: string[]): Promise<Set<string>> {
	if (memberIds.length === 0) return new Set();
	const { member } = schema;
	const [paused, present] = await Promise.all([
		pausedAmong(db, memberIds),
		db.select({ id: member.id }).from(member).where(inArray(member.id, memberIds)).all(),
	]);
	const members = new Set(present.map((row) => row.id));
	return new Set(memberIds.filter((id) => paused.has(id) || !members.has(id)));
}

/**
 * Deletes agents that no longer belong to a workspace. An agent belongs to one workspace only, so
 * once that workspace is gone, nothing else can use it. Anyone with a way to sign in is a person,
 * whatever their address, and is never touched.
 */
export async function deleteOrphanedAgents(db: Database): Promise<void> {
	const { account, member, user } = schema;
	await db
		.delete(user)
		.where(
			and(
				like(user.email, `%@${AGENT_EMAIL_DOMAIN}`),
				notExists(db.select({ id: member.id }).from(member).where(eq(member.userId, user.id))),
				notExists(db.select({ id: account.id }).from(account).where(eq(account.userId, user.id))),
			),
		)
		.run();
}

export interface AgentKeyInfo {
	id: string;
	/** The key's first characters, as shown in settings. */
	start: string;
	createdAt: number;
	lastUsedAt: number | null;
}

export interface AgentInfo {
	/** The agent's user id. */
	id: string;
	/** Its membership's id, which mailboxes are given to. */
	memberId: string;
	name: string;
	createdAt: number;
	keys: AgentKeyInfo[];
	/** What it may send. */
	policy: AgentPolicy;
	/** What addresses it may make for itself. */
	addressPolicy: AgentAddressPolicy;
	/** How many of those it holds now. */
	liveAddresses: number;
	/** When it was paused and by whom, by name while their account lasts; null while it runs. */
	paused: AgentPauseInfo | null;
}

export interface AgentPauseInfo {
	at: number;
	by: string | null;
}

/**
 * What this agent's membership may send: its policy, or the defaults when none was set. Read as the
 * agent sends, so a change counts from its next message.
 */
export async function agentPolicyOf(db: Database, memberId: string): Promise<AgentPolicy> {
	const { agentPolicy } = schema;
	const row = await db
		.select({ sendPerDay: agentPolicy.sendPerDay, allowed: agentPolicy.allowed })
		.from(agentPolicy)
		.where(eq(agentPolicy.memberId, memberId))
		.get();
	return row
		? { sendPerDay: row.sendPerDay, allowed: readAllowed(row.allowed) }
		: DEFAULT_AGENT_POLICY;
}

const agentName = z.string().trim().min(1).max(80);
const id = z.string().min(1).max(64);

export function agentMembers({ db }: { db: Database }) {
	const { agentAddressPolicy, agentKey, agentPause, agentPolicy, mailDomain, member, user } =
		schema;
	const pauser = alias(user, "pauser");

	async function pauseOf(memberId: string): Promise<AgentPauseInfo | null> {
		const row = await db
			.select({ at: agentPause.pausedAt, by: pauser.name })
			.from(agentPause)
			.leftJoin(pauser, eq(pauser.id, agentPause.pausedBy))
			.where(eq(agentPause.memberId, memberId))
			.get();
		return row ? { at: row.at.getTime(), by: row.by } : null;
	}

	async function requireAdmin(organizationId: string, userId: string) {
		const row = await db
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
			.get();
		if (!row || !isAdminRole(toRole(row.role))) {
			throw new APIError("FORBIDDEN", { message: "Only workspace admins can manage agents" });
		}
	}

	/**
	 * An agent and its workspace, for an admin of that workspace. Only an account this plugin made,
	 * under an agent's address: deleting an agent deletes its account, which must never be a person's.
	 */
	async function agentForAdmin(agentId: string, userId: string) {
		const agent = await db
			.select({
				id: user.id,
				name: user.name,
				memberId: member.id,
				organizationId: member.organizationId,
			})
			.from(member)
			.innerJoin(user, eq(member.userId, user.id))
			.where(
				and(
					eq(member.userId, agentId),
					eq(member.role, AGENT_ROLE),
					like(user.email, `%@${AGENT_EMAIL_DOMAIN}`),
				),
			)
			.get();
		if (!agent) throw new APIError("NOT_FOUND", { message: "That agent was deleted" });
		await requireAdmin(agent.organizationId, userId);
		return agent;
	}

	async function insertKey(agentId: string, organizationId: string) {
		const key = await newKey();
		const createdAt = new Date();
		const keyId = crypto.randomUUID();
		await db
			.insert(agentKey)
			.values({ id: keyId, userId: agentId, organizationId, ...key, createdAt })
			.run();
		const info: AgentKeyInfo = {
			id: keyId,
			start: key.start,
			createdAt: createdAt.getTime(),
			lastUsedAt: null,
		};
		return { info, secret: key.secret };
	}

	return {
		id: "agent-members",
		schema: {
			agentKey: {
				fields: {
					userId: {
						type: "string",
						required: true,
						references: { model: "user", field: "id", onDelete: "cascade" },
						index: true,
					},
					organizationId: {
						type: "string",
						required: true,
						references: { model: "organization", field: "id", onDelete: "cascade" },
						index: true,
					},
					start: { type: "string", required: true },
					hash: { type: "string", required: true, unique: true },
					createdAt: { type: "date", required: true },
					lastUsedAt: { type: "date", required: false },
				},
			},
		},
		endpoints: {
			listAgents: createAuthEndpoint(
				"/agents/list",
				{
					method: "GET",
					query: z.object({ organizationId: id }),
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const { organizationId } = ctx.query;
					await requireAdmin(organizationId, ctx.context.session.user.id);
					const rows = await db
						.select({
							id: user.id,
							memberId: member.id,
							name: user.name,
							createdAt: member.createdAt,
							sendPerDay: agentPolicy.sendPerDay,
							allowed: agentPolicy.allowed,
							address: {
								maxLive: agentAddressPolicy.maxLive,
								maxDays: agentAddressPolicy.maxDays,
								domains: agentAddressPolicy.domains,
							},
							key: {
								id: agentKey.id,
								start: agentKey.start,
								createdAt: agentKey.createdAt,
								lastUsedAt: agentKey.lastUsedAt,
							},
							pausedAt: agentPause.pausedAt,
							pausedBy: pauser.name,
						})
						.from(member)
						.innerJoin(user, eq(member.userId, user.id))
						.leftJoin(agentPause, eq(agentPause.memberId, member.id))
						.leftJoin(pauser, eq(pauser.id, agentPause.pausedBy))
						.leftJoin(agentKey, eq(agentKey.userId, user.id))
						.leftJoin(agentPolicy, eq(agentPolicy.memberId, member.id))
						.leftJoin(agentAddressPolicy, eq(agentAddressPolicy.memberId, member.id))
						.where(
							and(
								eq(member.organizationId, organizationId),
								eq(member.role, AGENT_ROLE),
								like(user.email, `%@${AGENT_EMAIL_DOMAIN}`),
							),
						)
						.orderBy(asc(user.name), asc(agentKey.createdAt))
						.all();
					const live = await liveAddressCounts(
						db,
						[...new Set(rows.map((row) => row.memberId))],
						new Date(),
					);
					const agents = new Map<string, AgentInfo>();
					for (const row of rows) {
						const agent = agents.get(row.id) ?? {
							id: row.id,
							memberId: row.memberId,
							name: row.name,
							createdAt: row.createdAt.getTime(),
							keys: [],
							policy:
								row.sendPerDay === null || row.allowed === null
									? DEFAULT_AGENT_POLICY
									: { sendPerDay: row.sendPerDay, allowed: readAllowed(row.allowed) },
							addressPolicy: row.address
								? {
										maxLive: row.address.maxLive,
										maxDays: row.address.maxDays,
										domains: readDomains(row.address.domains),
									}
								: DEFAULT_AGENT_ADDRESS_POLICY,
							liveAddresses: live.get(row.memberId) ?? 0,
							paused:
								row.pausedAt === null ? null : { at: row.pausedAt.getTime(), by: row.pausedBy },
						};
						agents.set(row.id, agent);
						if (row.key) {
							agent.keys.push({
								id: row.key.id,
								start: row.key.start,
								createdAt: row.key.createdAt.getTime(),
								lastUsedAt: row.key.lastUsedAt?.getTime() ?? null,
							});
						}
					}
					return ctx.json([...agents.values()]);
				},
			),

			createAgent: createAuthEndpoint(
				"/agents/create",
				{
					method: "POST",
					body: z.object({ organizationId: id, name: agentName }),
					// A key reads mail until it is revoked, even after the session that made it is gone,
					// so making one takes a recent sign-in: a stolen cookie can't leave a key behind.
					use: [freshSessionMiddleware],
				},
				async (ctx) => {
					const { organizationId, name } = ctx.body;
					await requireAdmin(organizationId, ctx.context.session.user.id);
					const existing = await db
						.select({ n: count() })
						.from(member)
						.where(and(eq(member.organizationId, organizationId), eq(member.role, AGENT_ROLE)))
						.get();
					if ((existing?.n ?? 0) >= MAX_AGENTS_PER_WORKSPACE) {
						throw new APIError("BAD_REQUEST", {
							message: `A workspace can have ${MAX_AGENTS_PER_WORKSPACE} agents`,
						});
					}

					const agentId = crypto.randomUUID();
					const memberId = crypto.randomUUID();
					const now = new Date();
					await db.batch([
						db.insert(user).values({
							id: agentId,
							name,
							email: `${agentId}@${AGENT_EMAIL_DOMAIN}`,
							emailVerified: false,
							image: null,
							createdAt: now,
							updatedAt: now,
						}),
						db.insert(member).values({
							id: memberId,
							organizationId,
							userId: agentId,
							role: AGENT_ROLE,
							createdAt: now,
						}),
					]);
					const key = await insertKey(agentId, organizationId);
					const agent: AgentInfo = {
						id: agentId,
						memberId,
						name,
						createdAt: now.getTime(),
						keys: [key.info],
						policy: DEFAULT_AGENT_POLICY,
						addressPolicy: DEFAULT_AGENT_ADDRESS_POLICY,
						liveAddresses: 0,
						paused: null,
					};
					return ctx.json({ agent, key: key.secret });
				},
			),

			updateAgent: createAuthEndpoint(
				"/agents/update",
				{
					method: "POST",
					body: z.object({ agentId: id, name: agentName }),
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const agent = await agentForAdmin(ctx.body.agentId, ctx.context.session.user.id);
					await db
						.update(user)
						.set({ name: ctx.body.name, updatedAt: new Date() })
						.where(eq(user.id, agent.id))
						.run();
					return ctx.json({ id: agent.id, name: ctx.body.name });
				},
			),

			setAgentPolicy: createAuthEndpoint(
				"/agents/set-policy",
				{
					method: "POST",
					body: z.object({ agentId: id }).extend(AgentPolicyInput.shape),
					// Letting an agent mail more people without approval is as much a grant as a key, so a
					// stolen cookie can't do it either.
					use: [freshSessionMiddleware],
				},
				async (ctx) => {
					const agent = await agentForAdmin(ctx.body.agentId, ctx.context.session.user.id);
					const allowed = JSON.stringify([...new Set(ctx.body.allowed)].sort());
					const values = {
						sendPerDay: ctx.body.sendPerDay,
						allowed,
						updatedBy: ctx.context.session.user.id,
						updatedAt: new Date(),
					};
					await db
						.insert(agentPolicy)
						.values({ memberId: agent.memberId, ...values })
						.onConflictDoUpdate({ target: agentPolicy.memberId, set: values })
						.run();
					const policy: AgentPolicy = {
						sendPerDay: ctx.body.sendPerDay,
						allowed: readAllowed(allowed),
					};
					return ctx.json({ id: agent.id, policy });
				},
			),

			setAgentAddressPolicy: createAuthEndpoint(
				"/agents/set-address-policy",
				{
					method: "POST",
					body: z.object({ agentId: id }).extend(AgentAddressPolicyInput.shape),
					// Letting an agent take mail at addresses of its own is as much a grant as a key.
					use: [freshSessionMiddleware],
				},
				async (ctx) => {
					const agent = await agentForAdmin(ctx.body.agentId, ctx.context.session.user.id);
					const domains = [...new Set(ctx.body.domains)].sort();
					// Only domains the workspace has proved now. One proved later is given then.
					const proved =
						domains.length === 0
							? []
							: await db
									.select({ name: mailDomain.name })
									.from(mailDomain)
									.where(
										and(
											eq(mailDomain.organizationId, agent.organizationId),
											isNotNull(mailDomain.verifiedAt),
											inArray(mailDomain.name, domains),
										),
									)
									.all();
					if (proved.length !== domains.length) {
						throw new APIError("BAD_REQUEST", {
							message: "Choose among the domains this workspace has proved.",
						});
					}
					const values = {
						maxLive: ctx.body.maxLive,
						maxDays: ctx.body.maxDays,
						domains: JSON.stringify(domains),
						updatedBy: ctx.context.session.user.id,
						updatedAt: new Date(),
					};
					await db
						.insert(agentAddressPolicy)
						.values({ memberId: agent.memberId, ...values })
						.onConflictDoUpdate({ target: agentAddressPolicy.memberId, set: values })
						.run();
					const addressPolicy: AgentAddressPolicy = {
						maxLive: ctx.body.maxLive,
						maxDays: ctx.body.maxDays,
						domains,
					};
					return ctx.json({ id: agent.id, addressPolicy });
				},
			),

			pauseAgent: createAuthEndpoint(
				"/agents/pause",
				{
					method: "POST",
					body: z.object({ agentId: id }),
					// Stopping an agent takes nothing from anyone, so it needs no recent sign-in: it
					// should be quick.
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const agent = await agentForAdmin(ctx.body.agentId, ctx.context.session.user.id);
					// Paused again, it stays paused as it first was.
					await db
						.insert(agentPause)
						.values({
							memberId: agent.memberId,
							pausedBy: ctx.context.session.user.id,
							pausedAt: new Date(),
						})
						.onConflictDoNothing()
						.run();
					return ctx.json({ id: agent.id, paused: await pauseOf(agent.memberId) });
				},
			),

			resumeAgent: createAuthEndpoint(
				"/agents/resume",
				{
					method: "POST",
					body: z.object({ agentId: id }),
					// It gives the agent's keys back, as much a grant as a new key.
					use: [freshSessionMiddleware],
				},
				async (ctx) => {
					const agent = await agentForAdmin(ctx.body.agentId, ctx.context.session.user.id);
					await db.delete(agentPause).where(eq(agentPause.memberId, agent.memberId)).run();
					return ctx.json({ id: agent.id, paused: null });
				},
			),

			createAgentKey: createAuthEndpoint(
				"/agents/create-key",
				{
					method: "POST",
					body: z.object({ agentId: id }),
					use: [freshSessionMiddleware],
				},
				async (ctx) => {
					const agent = await agentForAdmin(ctx.body.agentId, ctx.context.session.user.id);
					const keys = await db
						.select({ n: count() })
						.from(agentKey)
						.where(eq(agentKey.userId, agent.id))
						.get();
					if ((keys?.n ?? 0) >= MAX_KEYS_PER_AGENT) {
						throw new APIError("BAD_REQUEST", {
							message: `An agent can have ${MAX_KEYS_PER_AGENT} keys. Revoke one first.`,
						});
					}
					const key = await insertKey(agent.id, agent.organizationId);
					return ctx.json({ key: key.info, secret: key.secret });
				},
			),

			revokeAgentKey: createAuthEndpoint(
				"/agents/revoke-key",
				{
					method: "POST",
					body: z.object({ keyId: id }),
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const key = await db
						.select({ id: agentKey.id, organizationId: agentKey.organizationId })
						.from(agentKey)
						.where(eq(agentKey.id, ctx.body.keyId))
						.get();
					if (!key) throw new APIError("NOT_FOUND", { message: "That key was revoked" });
					await requireAdmin(key.organizationId, ctx.context.session.user.id);
					await db.delete(agentKey).where(eq(agentKey.id, key.id)).run();
					// The webhooks made with it go with it, as whoever held it may have made them.
					const { removeKeyWebhooks } = await import("../webhooks");
					await removeKeyWebhooks(key.organizationId, key.id);
					return ctx.json({ id: key.id });
				},
			),

			deleteAgent: createAuthEndpoint(
				"/agents/delete",
				{
					method: "POST",
					body: z.object({ agentId: id }),
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const agent = await agentForAdmin(ctx.body.agentId, ctx.context.session.user.id);
					// The account goes with its membership, keys and the mailboxes it was given.
					await db.batch([
						db.delete(agentKey).where(eq(agentKey.userId, agent.id)),
						db.delete(member).where(eq(member.userId, agent.id)),
						db.delete(user).where(eq(user.id, agent.id)),
					]);
					// And the webhooks it made for itself. Imported here, as the webhooks object reads
					// this module.
					const { removeAgentWebhooks } = await import("../webhooks");
					await removeAgentWebhooks(agent.organizationId, agent.memberId);
					return ctx.json({ id: agent.id });
				},
			),
		},

		hooks: {
			before: [
				{
					// Nobody signs up, signs in, recovers, verifies or is invited under an agent's
					// address, and no one takes one as their own.
					matcher: (ctx) => EMAIL_FIELDS.has(ctx.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						const field = EMAIL_FIELDS.get(ctx.path) ?? "email";
						const email: unknown = ctx.body?.[field];
						if (typeof email === "string" && isAgentEmail(email)) {
							throw new APIError("BAD_REQUEST", {
								message: "That address belongs to an agent",
							});
						}
					}),
				},
				{
					// Agents are managed in their own settings, where deleting one also revokes its keys.
					// An agent's role never changes: as an admin, a key would manage the workspace.
					matcher: (ctx) =>
						ctx.path === "/organization/update-member-role" ||
						ctx.path === "/organization/remove-member",
					handler: createAuthMiddleware(async (ctx) => {
						const memberId: unknown = ctx.body?.memberId ?? ctx.body?.memberIdOrEmail;
						if (typeof memberId !== "string") return;
						const target = await db
							.select({ role: member.role, email: user.email })
							.from(member)
							.innerJoin(user, eq(member.userId, user.id))
							.where(or(eq(member.id, memberId), eq(user.email, memberId.trim().toLowerCase())))
							.all();
						if (target.some(isAgentMember)) {
							throw new APIError("FORBIDDEN", {
								message: "Manage agents in the workspace's agent settings",
							});
						}
					}),
				},
			],
			after: [
				{
					// A deleted workspace takes its agents' memberships and keys with it. The agents
					// themselves belonged nowhere else, so they go too.
					matcher: (ctx) => ctx.path === "/organization/delete",
					handler: createAuthMiddleware(() => deleteOrphanedAgents(db)),
				},
			],
		},

		rateLimit: [
			// Each key is a credential; nobody needs many.
			{ pathMatcher: (path) => path === "/agents/create", window: 60, max: 10 },
			{ pathMatcher: (path) => path === "/agents/create-key", window: 60, max: 20 },
		],
	} satisfies BetterAuthPlugin;
}

/** Paths that take an address, and the body field it is in. */
const EMAIL_FIELDS: ReadonlyMap<string, string> = new Map([
	["/sign-up/email", "email"],
	["/sign-in/email", "email"],
	["/request-password-reset", "email"],
	["/send-verification-email", "email"],
	["/change-email", "newEmail"],
	["/organization/invite-member", "email"],
]);
