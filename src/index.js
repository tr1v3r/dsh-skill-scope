/**
 * Layer A — allowlist-scoped filesystem skill provider.
 *
 * Wraps `FileSystemSkillProvider` from @deepseek-ai/dsh-skill-filesystem and
 * filters its discovery results through an allowlist/denylist before they
 * reach the `ctx.skills` registry. Mount this provider INSTEAD of the plain
 * filesystem provider inside a worker agent's composition (an agent preset),
 * and that agent's skill catalog physically contains only the allowed names.
 *
 * Motivation: "More Skills, Worse Agents? Skill Shadowing Degrades
 * Performance When Expanding Skill Libraries" (arXiv:2605.24050) shows the
 * dominant cost of large skill libraries is *selection failure* (shadowing),
 * not raw context size — narrowing the visible set removes that failure mode.
 *
 * @module @tr1v3r/dsh-skill-scope
 */
import z from "@deepseek-ai/schemastery";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";

export const name = "skill-scope";

export const inject = ["skills"];

export const Config = z.object({
	/** Unique provider name registered on ctx.skills. */
	providerName: z.string().min(1).default("skill-scope"),
	/** When non-empty, only these skill names are visible. Takes precedence over denySkills. */
	allowSkills: z.array(z.string()).default([]),
	/** Skill names never visible, even when matched by allowSkills. */
	denySkills: z.array(z.string()).default([]),
	/**
	 * Reject `skill` loads for names outside the scope. Without this, the
	 * model could still load an out-of-scope skill by name if some other
	 * provider is mounted in the same composition.
	 */
	enforceOnGet: z.boolean().default(true),
	// --- passthrough to the wrapped filesystem provider ---
	includeDefaultRoots: z.boolean().default(true),
	dshHome: z.string(),
	agentsHome: z.string(),
	customSkillDirs: z.array(z.string()).default([]),
	watch: z.boolean().default(true),
	watchUsePolling: z.boolean().default(false),
	watchStabilityThresholdMs: z.number(),
	watchPollIntervalMs: z.number(),
	watchMaxProjects: z.number(),
	watchFollowSymlinks: z.boolean().default(true),
	bundledSkillDir: z.string(),
});

function skillNameOf(candidate) {
	// Candidates carry the parsed frontmatter name; tolerate raw entries.
	return typeof candidate?.name === "string" ? candidate.name : undefined;
}

/** Register the scoped provider on `ctx.skills`. */
export function apply(ctx, config = {}) {
	const allow = new Set(config.allowSkills ?? []);
	const deny = new Set(config.denySkills ?? []);

	const inScope = (skillName) => {
		if (typeof skillName !== "string") return false;
		if (deny.has(skillName)) return false;
		if (allow.size > 0) return allow.has(skillName);
		return true;
	};

	ctx.skills.registerProvider((control) => {
		const inner = new FileSystemSkillProvider(ctx, control, {
			providerName: `${config.providerName ?? "skill-scope"}:fs`,
			includeDefaultRoots: config.includeDefaultRoots ?? true,
			dshHome: config.dshHome,
			agentsHome: config.agentsHome,
			customSkillDirs: config.customSkillDirs ?? [],
			watch: config.watch ?? true,
			watchUsePolling: config.watchUsePolling ?? false,
			watchStabilityThresholdMs: config.watchStabilityThresholdMs,
			watchPollIntervalMs: config.watchPollIntervalMs,
			watchMaxProjects: config.watchMaxProjects,
			watchFollowSymlinks: config.watchFollowSymlinks ?? true,
			bundledSkillDir: config.bundledSkillDir,
		});

		const outerName = config.providerName ?? "skill-scope";

		const provider = {
			name: outerName,
			/** The inner provider name is reserved for the wrapper's own registration. */
			async list(options) {
				const result = await inner.list(options);
				// Successful discovery returns an array; incomplete discovery returns an observation.
				const observation = Array.isArray(result) ? { candidates: result, complete: true } : result;
				const candidates = observation.candidates.filter((candidate) => {
					const visible = inScope(skillNameOf(candidate));
					if (!visible && config.debug === true) {
						ctx.logger?.warn?.(`skill-scope: hiding "${skillNameOf(candidate)}" (out of scope)`);
					}
					return visible;
				});
				return { candidates, complete: observation.complete };
			},
			async get(candidate, options) {
				if (config.enforceOnGet !== false && !inScope(skillNameOf(candidate))) {
					throw new Error(`skill "${skillNameOf(candidate)}" is out of scope for provider "${outerName}"`);
				}
				return inner.get(candidate, options);
			},
			observeHostMutation(path) {
				return inner.observeHostMutation?.(path);
			},
			async dispose() {
				return inner.dispose?.();
			},
		};

		// The inner provider was constructed directly; register it nowhere else.
		// Its control (invalidate/signal) is shared, so watcher invalidation
		// propagates through this wrapper's registration.
		return provider;
	});
}
