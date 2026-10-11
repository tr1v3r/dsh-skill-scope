/**
 * Layer B (experimental) — scoped worker dispatch.
 *
 * Provides `ctx.skillScope` with one method:
 *
 *   const handle = await ctx.skillScope.spawnWorker({
 *     name: "rater-a",
 *     skills: ["paper-review-eval"],   // borrowed from THIS agent's registry
 *     prompt: "Score the thesis independently. Output JSON per contract.",
 *   });
 *   await handle.agent.whenIdle();
 *
 * The worker is created through `ctx.agents.create()`; its `setup` callback
 * mounts a runtime layer into which each allowed skill is re-registered as a
 * borrowed readonly skill (`ctx.skills.register(...)`), and no filesystem
 * provider is mounted — so the worker's catalog contains exactly the listed
 * skills, nothing else.
 *
 * Status: experimental. The `agents.create` options surface and the runtime
 * registration contract are pinned against dsh 0.2.0-rc.x; composition-level
 * testing is still pending (see README roadmap).
 *
 * @module @tr1v3r/dsh-skill-scope/worker
 */
import z from "@deepseek-ai/schemastery";

export const name = "skill-scope-worker";

export const inject = ["agents", "skills"];

export const Config = z.object({
	/** Mount a `spawn_scoped_worker` tool for the model (default: service only). */
	exposeTool: z.boolean().default(false),
});

function defineService(ctx, config) {
	ctx.provide?.("skillScope", {
		/**
		 * Spawn a worker agent whose skill catalog is exactly `skills`.
		 * Skill definitions are borrowed (read-only) from the caller's
		 * registry, so cross-layer name rank does not change.
		 */
		spawnWorker: async (options) => {
			const { name, skills = [], prompt, ...rest } = options ?? {};
			if (typeof name !== "string" || name.length === 0) throw new Error("spawnWorker: name is required");
			if (!Array.isArray(skills) || skills.length === 0) throw new Error("spawnWorker: skills must be a non-empty array");

			const borrowed = [];
			for (const skillName of skills) {
				const definition = await ctx.skills.get(skillName).catch(() => undefined);
				if (definition === undefined) throw new Error(`spawnWorker: skill "${skillName}" not found in the caller's registry`);
				borrowed.push(definition);
			}

			return ctx.agents.create({
				...rest,
				parentAgent: ctx.agent?.id,
				setup: async (agentCtx, agent) => {
					// No filesystem provider is mounted in this composition:
					// the runtime layer below is the worker's only skill source.
					for (const definition of borrowed) {
						await agentCtx.skills.register(definition);
					}
					await agent.followup({
						content: [{ type: "text", text: prompt }],
						source: { kind: "plugin", plugin: "skill-scope-worker" },
					});
					return agent;
				},
			});
		},
	});
}

export function apply(ctx, config = {}) {
	defineService(ctx, config);
	// Tool exposure is intentionally deferred: the service surface is stable
	// first (orchestrator plugins call ctx.skillScope), the model-facing tool
	// lands after composition-level tests. See README roadmap.
}
