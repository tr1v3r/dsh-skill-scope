import { test } from "node:test";
import assert from "node:assert/strict";
import * as layerB from "../src/worker.js";

// ---------------------------------------------------------------------------
// Layer B — spawnWorker success path with a stubbed agents/skills ctx
// ---------------------------------------------------------------------------

/**
 * Build the service around a stub ctx that records every interaction:
 * skills.get resolves definitions by name, agents.create captures its
 * options and actually invokes the setup callback.
 */
function buildRecordingService({ definitions = {}, agent = { id: "parent-1" } } = {}) {
	if (agent === null) agent = undefined;
	const state = {
		registered: [],
		followups: [],
		createOptions: null,
		setupInvoked: false,
	};
	const ctx = {
		provide: (key, value) => {
			if (key === "skillScope") state.service = value;
		},
		agent,
		skills: {
			get: async (name) => definitions[name],
		},
		agents: {
			create: async (options) => {
				state.createOptions = options;
				const agent = {
					followup: async (payload) => {
						state.followups.push(payload);
					},
				};
				state.setupInvoked = true;
				state.setupResult = await options.setup(
					{ skills: { register: async (definition) => state.registered.push(definition) } },
					agent,
				);
				return { agent: state.setupResult };
			},
		},
	};
	layerB.apply(ctx, layerB.Config({}));
	assert.equal(typeof state.service?.spawnWorker, "function");
	return { service: state.service, state };
}

test("spawnWorker creates the agent with parentAgent, name, and pass-through options", async () => {
	const { service, state } = buildRecordingService({
		definitions: { alpha: { name: "alpha", content: "Alpha instructions." } },
	});
	const handle = await service.spawnWorker({
		name: "rater-a",
		skills: ["alpha"],
		prompt: "Score it.",
		model: "glm-5.3",
	});
	assert.ok(handle.agent, "agents.create return value is forwarded");
	assert.equal(state.setupInvoked, true);
	assert.equal(state.createOptions.name, undefined, "name is consumed for validation, not forwarded");
	assert.equal(state.createOptions.parentAgent, "parent-1");
	assert.equal(state.createOptions.model, "glm-5.3");
	assert.equal(state.createOptions.prompt, undefined, "prompt is consumed, not forwarded");
});

test("spawnWorker setup registers borrowed skills then follows up with the prompt", async () => {
	const alpha = { name: "alpha", content: "Alpha instructions." };
	const { service, state } = buildRecordingService({ definitions: { alpha } });
	const handle = await service.spawnWorker({
		name: "rater-a",
		skills: ["alpha"],
		prompt: "Score the thesis.",
	});
	assert.deepEqual(state.registered, [alpha]);
	assert.equal(state.followups.length, 1);
	assert.deepEqual(state.followups[0], {
		content: [{ type: "text", text: "Score the thesis." }],
		source: { kind: "plugin", plugin: "skill-scope-worker" },
	});
	assert.equal(state.setupResult, handle.agent, "setup returns the agent itself");
});

test("spawnWorker registers multiple borrowed skills in the listed order", async () => {
	const alpha = { name: "alpha", content: "Alpha instructions." };
	const beta = { name: "beta", content: "Beta instructions." };
	const gamma = { name: "gamma", content: "Gamma instructions." };
	const { service, state } = buildRecordingService({
		definitions: { alpha, beta, gamma },
	});
	await service.spawnWorker({
		name: "rater-b",
		skills: ["gamma", "alpha", "beta"],
		prompt: "Do all three.",
	});
	// Exactly the listed skills, nothing else, in the caller's order.
	assert.deepEqual(state.registered.map((definition) => definition.name), ["gamma", "alpha", "beta"]);
	assert.equal(state.followups.length, 1);
});

test("spawnWorker without ctx.agent spawns with parentAgent undefined", async () => {
	const { service, state } = buildRecordingService({
		definitions: { alpha: { name: "alpha" } },
		agent: null,
	});
	await service.spawnWorker({ name: "orphan", skills: ["alpha"], prompt: "x" });
	assert.equal(state.createOptions.parentAgent, undefined);
});

test("spawnWorker tolerates null options with the documented validation error", async () => {
	const { service } = buildRecordingService();
	// Current implementation destructures `options ?? {}` and fails on name first.
	await assert.rejects(service.spawnWorker(null), /name is required/);
});

test("spawnWorker without prompt still spawns and follows up with undefined text", async () => {
	const { service, state } = buildRecordingService({
		definitions: { alpha: { name: "alpha" } },
	});
	await service.spawnWorker({ name: "silent", skills: ["alpha"] });
	assert.deepEqual(state.registered, [{ name: "alpha" }]);
	assert.deepEqual(state.followups, [{
		content: [{ type: "text", text: undefined }],
		source: { kind: "plugin", plugin: "skill-scope-worker" },
	}]);
});
