#!/usr/bin/env -S deno run --allow-read --allow-run

import { dirname, fromFileUrl, join } from "jsr:@std/path";

async function hasOpenshell() {
	try {
		const cmd = new Deno.Command("which", {
			args: ["openshell"],
			stdout: "null",
			stderr: "null",
		});
		const { code } = await cmd.output();
		return code === 0;
	} catch {
		return false;
	}
}

if (Deno.args.length !== 2) {
	console.error("Usage: sandbox.js <name> <path>");
	Deno.exit(1);
}

const name = Deno.args[0];
const pathArg = Deno.args[1];

if (!(await hasOpenshell())) {
	console.error("openshell not found in PATH. Please install openshell and ensure it is in your PATH.");
	Deno.exit(1);
}

export async function createSandbox(path, name) {
	let config;
	try {
		const text = await Deno.readTextFile("driver-config.json");
		config = JSON.parse(text);
	} catch (e) {
		throw new Error(e instanceof Error ? e.message : String(e));
	}

	if (!config.docker || !Array.isArray(config.docker.mounts)) {
		throw new Error("Invalid driver-config.json: missing docker.mounts array");
	}

	config.docker.mounts.push({
		type: "bind",
		source: path,
		target: `/sandbox/${name}`,
		read_only: false,
	});

	config.docker.mounts.push({
		type: "bind",
		source: `${path}/.git`,
		target: `/sandbox/${name}/.git`,
		read_only: true,
	});

	// OpenCode config: do NOT bind-mount the whole host opencode/ directory over
	// /sandbox/.config/opencode/. That path is created in the image as a
	// sandbox-owned writable directory so the runtime can write service.json,
	// cli.json, and themes/ inside the container. A whole-dir bind would hide
	// that writable layer and either force host ownership of those files or
	// make them read-only with the rest of the tree.
	//
	// Instead, bind each listed static item read-only only if the host path
	// exists (agents/, plugins/, themes/, skills/, prompts/, opencode.json,
	// .gitignore, .git). Missing ones (e.g. skills, prompts, optional .git)
	// are skipped. Host-only mutable state (service.json, cli.json) is never
	// mounted so the image's writable layer stays usable.
	const opencodeHost = join(dirname(fromFileUrl(import.meta.url)), "opencode");
	const opencodeTarget = "/sandbox/.config/opencode";
	const opencodeStatic = [
		"agents",
		"plugins",
		"themes",
		"skills",
		"prompts",
		"opencode.json",
		".gitignore",
		".git", // submodule gitdir pointer, if present
	];
	for (const item of opencodeStatic) {
		const source = join(opencodeHost, item);
		// Skip optional paths that are absent on the host (skills, prompts, .git).
		try {
			await Deno.stat(source);
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) continue;
			throw e;
		}
		config.docker.mounts.push({
			type: "bind",
			source,
			target: `${opencodeTarget}/${item}`,
			read_only: true,
		});
	}

	const jsonString = JSON.stringify(config);

	const image = `openshell-sandbox-${name}`;
	const build = await new Deno.Command("docker", {
		args: ["build", "-t", image, "."],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	}).output();
	if (build.code !== 0) Deno.exit(build.code);

	const args = [
		"sandbox",
		"create",
		"--name",
		name,
		"--from",
		image,
		"--expose",
		"9998",
		"--policy",
		"policy.yaml",
		"--driver-config-json",
		jsonString,
	];

	const userEnvPath = join(dirname(fromFileUrl(import.meta.url)), "user-env");
	try {
		const userEnvText = await Deno.readTextFile(userEnvPath);
		for (const line of userEnvText.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim();
			const value = trimmed.slice(eq + 1).trim();
			if (!key) continue;
			args.push("--env", `${key}=${value}`);
		}
	} catch {
		// user-env is optional
	}

	const cmd = new Deno.Command("openshell", {
		args,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	const { code } = await cmd.output();
	return code;
}

export async function sandboxExists(name) {
	const listCmd = new Deno.Command("openshell", {
		args: ["sandbox", "list", "-o", "json"],
		stdout: "piped",
		stderr: "piped",
	});
	const listOutput = await listCmd.output();
	if (listOutput.code !== 0) {
		const errText = new TextDecoder().decode(listOutput.stderr).trim();
		throw new Error(errText || `openshell sandbox list failed with code ${listOutput.code}`);
	}
	const listText = new TextDecoder().decode(listOutput.stdout);
	let sandboxes;
	try {
		sandboxes = JSON.parse(listText);
	} catch {
		return false;
	}
	if (!Array.isArray(sandboxes)) {
		return false;
	}
	return sandboxes.some((s) => s.name === name || s.id === name);
}

try {
	if (await sandboxExists(name)) {
		console.error(`Sandbox "${name}" already exists`);
		Deno.exit(1);
	}
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	Deno.exit(1);
}

try {
	const code = await createSandbox(pathArg, name);
	Deno.exit(code);
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	Deno.exit(1);
}
