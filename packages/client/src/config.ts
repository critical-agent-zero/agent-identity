import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProfileDir } from "./profile.js";

export interface MachineConfig {
  apiUrl?: string;
}

export const machineConfigPath = (base: string = defaultProfileDir()): string =>
  join(base, "config.json");

export function readMachineConfig(base?: string): MachineConfig {
  try {
    return JSON.parse(readFileSync(machineConfigPath(base), "utf8")) as MachineConfig;
  } catch {
    return {};
  }
}

export function writeMachineConfig(config: MachineConfig, base: string = defaultProfileDir()): void {
  mkdirSync(base, { recursive: true });
  writeFileSync(machineConfigPath(base), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export const fleetKeyPath = (base: string = defaultProfileDir()): string =>
  join(base, "fleet_key");

export function readFleetKeyFile(base?: string): string | undefined {
  try {
    const key = readFileSync(fleetKeyPath(base), "utf8").trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

export function writeFleetKeyFile(key: string, base: string = defaultProfileDir()): void {
  mkdirSync(base, { recursive: true });
  writeFileSync(fleetKeyPath(base), `${key.trim()}\n`, { mode: 0o600 });
}

export function resolveFleetKey(
  env: string | undefined = process.env.AGENT_IDENTITY_FLEET_KEY,
  base?: string,
): string | undefined {
  return env || readFleetKeyFile(base);
}

// GitHub PAT (bot account, user scope) for the onboarding-side email flow —
// operator only, never handed to agents. Env first, then the github_pat file
// (create it yourself, mode 600); reads do not enforce the mode.
export const githubPatPath = (base: string = defaultProfileDir()): string =>
  join(base, "github_pat");

export function readGithubPatFile(base?: string): string | undefined {
  try {
    const pat = readFileSync(githubPatPath(base), "utf8").trim();
    return pat || undefined;
  } catch {
    return undefined;
  }
}

export function resolveGithubPat(
  env: string | undefined = process.env.AGENT_IDENTITY_GITHUB_PAT,
  base?: string,
): string | undefined {
  return env || readGithubPatFile(base);
}
