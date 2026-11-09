// Profile registry: the built-in `host` profile plus any the user drops into
// ~/.config/my-claude/profiles/<name>.ts. An external profile is a module whose
// default export is `(api: ProfileApi) => Profile`; `api` hands it the helpers
// the core uses so it needs no import path into this checkout.
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { out, run, shq } from "../sh.ts";
import { CONFIG_DIR, config, die } from "../store.ts";
import { host } from "./host.ts";
import type { Profile, ProfileApi } from "./types.ts";

export const api: ProfileApi = { run, out, shq, config, home: process.env.HOME ?? "" };

async function loadExternal(): Promise<Record<string, Profile>> {
  const dir = join(CONFIG_DIR, "profiles");
  const found: Record<string, Profile> = {};
  if (!existsSync(dir)) return found;
  for (const f of readdirSync(dir)) {
    if (!/\.(ts|js|mjs)$/.test(f)) continue;
    const name = basename(f).replace(/\.(ts|js|mjs)$/, "");
    try {
      const mod = await import(join(dir, f));
      const p: Profile = typeof mod.default === "function" ? mod.default(api) : (mod.default ?? mod.profile);
      if (p && typeof p.launch === "function") found[name] = p;
      else console.error(`my-claude: profile ${f} exports no Profile`);
    } catch (e) {
      console.error(`my-claude: profile ${f} failed to load: ${e instanceof Error ? e.message : e}`);
    }
  }
  return found;
}

export const profiles: Record<string, Profile> = { host, ...(await loadExternal()) };

export function profile(name: string): Profile {
  return profiles[name] ?? die(`no profile '${name}' (have: ${Object.keys(profiles).join(", ")}; add ${CONFIG_DIR}/profiles/${name}.ts)`);
}
