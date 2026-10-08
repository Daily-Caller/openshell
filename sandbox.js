#!/usr/bin/env -S deno run --allow-read --allow-run

if (Deno.args.length !== 2) {
	console.error("Usage: sandbox.js <name> <path>");
	Deno.exit(1);
}

const name = Deno.args[0];
const pathArg = Deno.args[1];

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

	const jsonString = JSON.stringify(config);

	const cmd = new Deno.Command("openshell", {
		args: [
			"sandbox",
			"create",
			"--name",
			name,
			"--from",
			".",
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

try {
	Deno.exit(await createSandbox(pathArg, name));
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	Deno.exit(1);
}
