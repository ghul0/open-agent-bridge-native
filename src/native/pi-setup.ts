import { execFileSync } from "node:child_process";
import { access, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function setupCleanPi() {
  const root = process.env.NAB_PI_ROOT ?? join(homedir(), ".local/share/native-agent-broker/pi-clean");
  const agent = join(root, "agent");
  await mkdir(agent, { recursive: true, mode: 0o700 });
  let installed = false;
  try { await access(join(root, "node_modules/.bin/pi")); installed = true; } catch { /* Install only in the dedicated profile. */ }
  if (!installed) {
    try { await access(join(root, "package.json")); }
    catch { await writeFile(join(root, "package.json"), JSON.stringify({ private: true, dependencies: { "@earendil-works/pi-coding-agent": "0.85.1" } }, null, 2), { flag: "wx", mode: 0o600 }); }
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
  }
  const version = JSON.parse(await readFile(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
  if (version !== "0.85.1") throw new Error("Clean Pi profile has an unverified version; refusing to replace it");
  const managedAuth = process.env.NAB_PI_AUTH_FILE ?? join(homedir(), ".pi/agent/auth.json");
  try { await lstat(join(agent, "auth.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await access(managedAuth); await symlink(managedAuth, join(agent, "auth.json"));
  }
  // Copy only explicit non-secret provider choices; never copy OAuth or extensions.
  try { await access(join(agent, "settings.json")); }
  catch {
    let source: Record<string, unknown> = {};
    try { source = JSON.parse(await readFile(join(homedir(), ".pi/agent/settings.json"), "utf8")); } catch { /* Pi can prompt for a provider on first use. */ }
    const choices = Object.fromEntries(["defaultProvider", "defaultModel", "defaultThinkingLevel"].filter((key) => typeof source[key] === "string").map((key) => [key, source[key]]));
    await writeFile(join(agent, "settings.json"), JSON.stringify(choices, null, 2), { flag: "wx", mode: 0o600 });
  }
  return { root, version, auth: "managed OAuth reference; no secret copied" };
}
