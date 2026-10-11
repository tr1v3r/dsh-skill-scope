import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as layerA from "../src/index.js";

// ---------------------------------------------------------------------------
// Layer A — watcher invalidation propagates through the scoped wrapper
//
// src/index.js constructs the inner FileSystemSkillProvider with the very same
// `control` object the wrapper received from ctx.skills.registerProvider, so a
// filesystem mutation under a watched root should surface as control.invalidate
// and the next list() should observe the new disk state. These tests perform
// real filesystem writes inside a tmpdir and wait for real chokidar events
// (stability threshold tuned down; generous 10s ceiling against CI jitter).
// ---------------------------------------------------------------------------

const WATCH_TIMEOUT_MS = 10_000;
const WATCH_POLL_MS = 100;

/** Resolve once `probe()` returns truthy, or reject at the deadline. */
async function waitFor(probe, what) {
	const deadline = Date.now() + WATCH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, WATCH_POLL_MS));
	}
	throw new Error(`timed out after ${WATCH_TIMEOUT_MS}ms waiting for ${what}`);
}

/**
 * Build the wrapper exactly the way the plugin mounts it, against a scratch
 * skill root, with watching enabled and aggressive stability thresholds.
 */
async function buildWatchedProvider(t, skillDir) {
	let factory;
	let invalidations = 0;
	const ctx = {
		get: () => undefined,
		logger: { warn: () => {} },
		skills: {
			registerProvider: (fn) => {
				factory = fn;
			},
		},
	};
	const config = layerA.Config({
		includeDefaultRoots: false,
		customSkillDirs: [skillDir],
		watch: true,
		watchStabilityThresholdMs: 50,
		watchPollIntervalMs: 50,
	});
	layerA.apply(ctx, config);
	assert.equal(typeof factory, "function", "apply must register a provider factory");
	const controller = new AbortController();
	const provider = factory({
		invalidate: () => {
			invalidations += 1;
		},
		signal: controller.signal,
	});
	t.after(() => provider.dispose());
	return { provider, invalidations: () => invalidations };
}

/** Create a scratch skill root with one directory-bundle skill. */
async function makeScratchRoot(parent, name, description) {
	const dir = join(parent, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} body.\n`);
	return dir;
}

test("watcher invalidation reaches the wrapper's control on SKILL.md change", async (t) => {
	const scratch = await mkdtemp(join(tmpdir(), "dsh-skill-scope-watch-"));
	t.after(() => rm(scratch, { recursive: true, force: true }));
	const skillDir = join(scratch, "skills");
	await mkdir(skillDir, { recursive: true });
	const alphaDir = await makeScratchRoot(skillDir, "alpha", "Original description.");
	const alphaFile = join(alphaDir, "SKILL.md");
	const original = await readFile(alphaFile, "utf8");

	const { provider, invalidations } = await buildWatchedProvider(t, skillDir);
	// First discovery starts the watchers under the custom root.
	const before = await provider.list({});
	assert.deepEqual(before.candidates.map((entry) => entry.name), ["alpha"]);
	assert.equal(invalidations(), 0, "no invalidation before any mutation");

	await writeFile(alphaFile, original.replace("Original description.", "Edited description."));
	await waitFor(() => invalidations() > 0, "control.invalidate after SKILL.md change");
	assert.ok(invalidations() >= 1, "invalidate propagated through the wrapper registration");

	const after = await provider.list({});
	assert.equal(after.complete, true);
	assert.equal(after.candidates[0].description, "Edited description.");
});

test("list() reflects a newly added skill after watcher invalidation", async (t) => {
	const scratch = await mkdtemp(join(tmpdir(), "dsh-skill-scope-watch-"));
	t.after(() => rm(scratch, { recursive: true, force: true }));
	const skillDir = join(scratch, "skills");
	await mkdir(skillDir, { recursive: true });
	await makeScratchRoot(skillDir, "alpha", "Alpha description.");

	const { provider, invalidations } = await buildWatchedProvider(t, skillDir);
	const before = await provider.list({});
	assert.deepEqual(before.candidates.map((entry) => entry.name), ["alpha"]);

	await makeScratchRoot(skillDir, "bravo", "Bravo description.");
	await waitFor(() => invalidations() > 0, "control.invalidate after adding a skill bundle");

	const after = await provider.list({});
	assert.deepEqual(after.candidates.map((entry) => entry.name), ["alpha", "bravo"]);
	// The late-discovered skill must remain loadable through the wrapper.
	const definition = await provider.get(after.candidates.find((entry) => entry.name === "bravo"), {});
	assert.equal(definition.content, "bravo body.");
});
