import { spawnSync } from "node:child_process";

const [environment, action] = process.argv.slice(2);
const environments = new Set(["uat", "production"]);
const actions = new Set(["build", "deploy"]);

if (!environments.has(environment) || !actions.has(action)) {
  console.error("Usage: node scripts/cloudflare-environment.mjs <uat|production> <build|deploy>");
  process.exit(1);
}

const env = { ...process.env, CLOUDFLARE_ENV: environment };

function run(args) {
  const isWindows = process.platform === "win32";
  const command = isWindows ? process.env.ComSpec ?? "cmd.exe" : "pnpm";
  const commandArgs = isWindows
    ? ["/d", "/s", "/c", ["pnpm.cmd", ...args].join(" ")]
    : args;
  const result = spawnSync(command, commandArgs, {
    env,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(["exec", "astro", "build"]);

if (action === "deploy") {
  run(["exec", "wrangler", "deploy", "--env", environment]);
}
