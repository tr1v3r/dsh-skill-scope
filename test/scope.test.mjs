import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import * as layerA from "../src/index.js";
import * as layerB from "../src/worker.js";

const fixtureSkillDir = fileURLToPath(new URL("./fixtures/skills/", import.meta.url));

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

/** Build the real filesystem wrapper against isolated, read-only fixtures. */
function buildProvider(t, overrides = {}, ctxOverrides = {}) {
	let factory;
	const ctx = {
		get: () => undefined,
		logger: { warn: (message) => assert.fail(message) },
		...ctxOverrides,
		skills: {
			registerProvider: (fn) => {
				factory = fn;
			},
		},
	};
	const config = layerA.Config({
		includeDefaultRoots: false,
		customSkillDirs: [fixtureSkillDir],
		watch: false,
		...overrides,
	});
	layerA.apply(ctx, config);
	assert.equal(typeof factory, "function", "apply must register a provider factory");
	const provider = factory({ invalidate: () => {}, signal: new AbortController().signal });
	t.after(() => provider.dispose());
	return provider;
}

/** Discover a valid locator without filtering, as another provider might do. */
async function fixtureCandidate(t, name) {
	const { candidates } = await buildProvider(t).list({});
	const candidate = candidates.find((entry) => entry.name === name);
	assert.ok(candidate, `fixture skill "${name}" must be discovered`);
	return candidate;
}

test("get() rejects out-of-scope names when enforceOnGet is on", async (t) => {
	const provider = buildProvider(t, { allowSkills: ["alpha"] });
	const candidate = await fixtureCandidate(t, "beta");
	await assert.rejects(
		provider.get(candidate, {}),
		/out of scope for provider "skill-scope"/,
	);
});

test("get() loads an in-scope filesystem skill", async (t) => {
	const provider = buildProvider(t, { allowSkills: ["alpha"] });
	const { candidates } = await provider.list({});
	assert.deepEqual(candidates.map((entry) => entry.name), ["alpha"]);
	const definition = await provider.get(candidates[0], {});
	assert.equal(definition.name, "alpha");
	assert.equal(definition.content, "Alpha instructions.");
});

test("get() rejects a denied skill even when it is allowlisted", async (t) => {
	const provider = buildProvider(t, {
		allowSkills: ["alpha", "beta"],
		denySkills: ["beta"],
	});
	const candidate = await fixtureCandidate(t, "beta");
	await assert.rejects(provider.get(candidate, {}), /out of scope/);
});

test("get() loads an out-of-scope skill when enforceOnGet is off", async (t) => {
	const provider = buildProvider(t, {
		allowSkills: ["alpha"],
		enforceOnGet: false,
	});
	const candidate = await fixtureCandidate(t, "beta");
	const definition = await provider.get(candidate, {});
	assert.equal(definition.name, "beta");
	assert.equal(definition.content, "Beta instructions.");
	// Disabling load enforcement must not disable discovery filtering.
	const { candidates } = await provider.list({});
	assert.deepEqual(candidates.map((entry) => entry.name), ["alpha"]);
});

for (const { title, config, expected } of [
	{
		title: "list() exposes all candidates when both scope lists are empty",
		config: {},
		expected: ["alpha", "beta", "gamma"],
	},
	{
		title: "list() exposes only allowlisted candidates",
		config: { allowSkills: ["alpha", "beta"] },
		expected: ["alpha", "beta"],
	},
	{
		title: "list() gives the denylist precedence over the allowlist",
		config: { allowSkills: ["alpha", "beta"], denySkills: ["beta"] },
		expected: ["alpha"],
	},
	{
		title: "list() applies the denylist even when the allowlist is empty",
		config: { denySkills: ["beta"] },
		expected: ["alpha", "gamma"],
	},
	{
		title: "list() returns no candidates when no skills match the allowlist",
		config: { allowSkills: ["missing-skill"] },
		expected: [],
	},
]) {
	test(title, async (t) => {
		const provider = buildProvider(t, config);
		const observation = await provider.list({});
		assert.equal(observation.complete, true);
		assert.deepEqual(observation.candidates.map((entry) => entry.name), expected);
	});
}

for (const complete of [true, false]) {
	test(`list() filters structured observations and preserves complete=${complete}`, async (t) => {
		const { candidates } = await buildProvider(t).list({});
		t.mock.method(FileSystemSkillProvider.prototype, "list", async () => ({ candidates, complete }));
		const provider = buildProvider(t, {
			allowSkills: ["alpha", "beta"],
			denySkills: ["beta"],
		});
		assert.deepEqual(await provider.list({}), {
			candidates: [candidates.find((entry) => entry.name === "alpha")],
			complete,
		});
	});
}

test("Config keeps an explicit debug flag and leaves it unset by default", () => {
	assert.equal(layerA.Config({ debug: true }).debug, true);
	assert.equal(layerA.Config({}).debug, undefined);
});

test("list() warns about each hidden skill when debug is on", async (t) => {
	const warns = [];
	const provider = buildProvider(
		t,
		{ allowSkills: ["alpha"], debug: true },
		{ logger: { warn: (message) => warns.push(message) } },
	);
	const { candidates } = await provider.list({});
	assert.deepEqual(candidates.map((entry) => entry.name), ["alpha"]);
	assert.deepEqual(
		warns.map((message) => (message.match(/hiding "([^"]+)"/) ?? [])[1]),
		["beta", "gamma"],
	);
});

test("list() stays silent about hidden skills when debug is off", async (t) => {
	const warns = [];
	const provider = buildProvider(
		t,
		{ allowSkills: ["alpha"] },
		{ logger: { warn: (message) => warns.push(message) } },
	);
	const { candidates } = await provider.list({});
	assert.deepEqual(candidates.map((entry) => entry.name), ["alpha"]);
	assert.deepEqual(warns, []);
});

test("observeHostMutation and dispose forward to the inner provider", async (t) => {
	const observeMock = t.mock.method(
		FileSystemSkillProvider.prototype,
		"observeHostMutation",
		() => "observed",
	);
	const disposeMock = t.mock.method(
		FileSystemSkillProvider.prototype,
		"dispose",
		async () => "disposed",
	);
	const provider = buildProvider(t);
	assert.equal(provider.observeHostMutation("/some/skill.md"), "observed");
	assert.deepEqual(observeMock.mock.calls[0].arguments, ["/some/skill.md"]);
	assert.equal(await provider.dispose(), "disposed");
	assert.equal(disposeMock.mock.calls.length, 1);
});

test("list() drops bare candidates that carry no skill name", async (t) => {
	const { candidates } = await buildProvider(t).list({});
	t.mock.method(FileSystemSkillProvider.prototype, "list", async () => ({
		candidates: [...candidates, { path: "/bare/SKILL.md" }],
		complete: true,
	}));
	const provider = buildProvider(t, { allowSkills: ["alpha", "beta", "gamma"] });
	const observation = await provider.list({});
	assert.equal(observation.complete, true);
	assert.deepEqual(observation.candidates.map((entry) => entry.name), ["alpha", "beta", "gamma"]);
});

test("get() rejects a bare candidate as out of scope", async (t) => {
	const provider = buildProvider(t);
	await assert.rejects(
		provider.get({ path: "/bare/SKILL.md" }, {}),
		/out of scope for provider "skill-scope"/,
	);
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
