#!/usr/bin/env -S deno run --allow-read --allow-run

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

	if (!Array.isArray(config.docker.ports)) {
		config.docker.ports = [];
	}
	config.docker.ports.push({ host: 5000, container: 5000 });

	const jsonString = JSON.stringify(config);

	const image = `openshell-sandbox-${name}`;
	const build = await new Deno.Command("docker", {
		args: ["build", "-t", image, "."],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	}).output();
	if (build.code !== 0) Deno.exit(build.code);

	const cmd = new Deno.Command("openshell", {
		args: [
			"sandbox",
			"create",
			"--name",
			name,
			"--from",
			image,
			"--policy",
			"policy.yaml",
			"--driver-config-json",
			jsonString,
		],
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

export async function startOpencodeInSandbox(name) {
	const cmd = new Deno.Command("openshell", {
		args: [
			"sandbox",
			"exec",
			name,
			"--workdir",
			`/sandbox/${name}`,
			"opencode",
			"--port",
			"5000",
		],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const { code } = await cmd.output();
	if (code !== 0) {
		throw new Error(`opencode start failed with code ${code}`);
	}
	return code;
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
	if (code !== 0) {
		Deno.exit(code);
	}
	Deno.exit(await startOpencodeInSandbox(name));
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	Deno.exit(1);
}
