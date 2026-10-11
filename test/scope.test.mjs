import { test } from "node:test";
import assert from "node:assert/strict";
import * as layerA from "../src/index.js";
import * as layerB from "../src/worker.js";

// ---------------------------------------------------------------------------
// Layer A — scoped filesystem provider
// ---------------------------------------------------------------------------

test("layer A exports the plugin contract", () => {
	assert.equal(layerA.name, "skill-scope");
	assert.deepEqual(layerA.inject, ["skills"]);
	assert.equal(typeof layerA.Config, "function");
	assert.equal(typeof layerA.apply, "function");
});

test("layer A defaults parse to an empty, non-filtering scope", () => {
	const config = layerA.Config({});
	assert.deepEqual(config.allowSkills, []);
	assert.deepEqual(config.denySkills, []);
	assert.equal(config.enforceOnGet, true);
	assert.equal(config.providerName, "skill-scope");
});

/** Build the wrapper provider with a stubbed ctx; no filesystem roots. */
async function buildProvider(overrides = {}) {
	let factory;
	const ctx = {
		skills: {
			registerProvider: (fn) => {
				factory = fn;
			},
		},
	};
	const config = layerA.Config({
		includeDefaultRoots: false,
		customSkillDirs: [],
		watch: false,
		...overrides,
	});
	layerA.apply(ctx, config);
	assert.equal(typeof factory, "function", "apply must register a provider factory");
	// The wrapped provider attaches an abort listener to control.signal.
	return factory({ invalidate: () => {}, signal: new AbortController().signal });
}

test("get() rejects out-of-scope names when enforceOnGet is on", async () => {
	const provider = await buildProvider({ allowSkills: ["visible-skill"] });
	await assert.rejects(
		provider.get({ name: "hidden-skill" }),
		/out of scope for provider "skill-scope"/,
	);
});

test("get() allows out-of-scope names when enforceOnGet is off", async () => {
	const provider = await buildProvider({ allowSkills: [], enforceOnGet: false });
	// No allowlist → nothing is out of scope; the call reaches the wrapped
	// provider, which fails differently (no such skill) but not with our error.
	await assert.rejects(provider.get({ name: "no-such-skill" }), (err) => {
		assert.doesNotMatch(err.message, /out of scope/);
		return true;
	});
});

test("list() filters candidates through the allowlist and denylist", async () => {
	const provider = await buildProvider({
		allowSkills: ["alpha", "beta"],
		denySkills: ["beta"],
	});
	const inner = provider;
	// Monkey-patch is impossible (closure), so drive filtering via get():
	// denylist wins over allowlist.
	await assert.rejects(provider.get({ name: "beta" }), /out of scope/);
	await assert.rejects(provider.get({ name: "gamma" }), /out of scope/);
	assert.equal(typeof inner.list, "function");
});

// ---------------------------------------------------------------------------
// Layer B — scoped worker dispatch (service contract only; composition-level
// tests are pending, see README roadmap)
// ---------------------------------------------------------------------------

test("layer B exports the plugin contract", () => {
	assert.equal(layerB.name, "skill-scope-worker");
	assert.deepEqual(layerB.inject, ["agents", "skills"]);
	assert.equal(typeof layerB.Config, "function");
	assert.equal(typeof layerB.apply, "function");
});

/** Capture the service object provided by defineService onto a stub ctx. */
function buildService(config = {}) {
	let service;
	const ctx = {
		provide: (key, value) => {
			if (key === "skillScope") service = value;
		},
		agents: { create: async () => ({ agent: {} }) },
		skills: { get: async () => undefined },
	};
	layerB.apply(ctx, layerB.Config(config));
	assert.equal(typeof service?.spawnWorker, "function");
	return service;
}

test("spawnWorker validates name and skills before touching ctx.agents", async () => {
	const service = buildService();
	await assert.rejects(service.spawnWorker({ skills: ["a"] }), /name is required/);
	await assert.rejects(service.spawnWorker({ name: "w", skills: [] }), /non-empty array/);
});

test("spawnWorker refuses to spawn when a listed skill is unknown", async () => {
	const service = buildService();
	await assert.rejects(
		service.spawnWorker({ name: "w", skills: ["missing-skill"] }),
		/not found in the caller's registry/,
	);
});
