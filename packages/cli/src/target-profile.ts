/**
 * The native host contract `pioc` currently generates against, pinned in `pioc.lock.json` so
 * verification fails closed instead of silently regenerating output against a moved host.
 *
 * The OpenCode 2 pins below track a specific dev snapshot (`@opencode-ai/cli`/`@opencode-ai/plugin`
 * `0.0.0-dev-18204`), not a public `beta` release — this beta channel has moved its accepted plugin
 * contract more than once already (see `docs/design.md` and `docs/adr/0001-compile-native-targets.md`
 * for the earlier pins this compiler targeted before each move). Treat the constants below, not
 * either doc, as current; `pioc verify`'s `PORT_LOCK_TARGET_PROFILE_DRIFT` and
 * `runOpenCode2ConfigDiscoverySmoke`'s exact-version check are what actually enforce them.
 */
export const PI_HOST_PIN = "@earendil-works/pi-coding-agent@0.84.3";

/** The bare version string `opencode2 --version` must report for the discovery smoke to run for real. */
export const OPENCODE2_HOST_VERSION = "0.0.0-dev-18204";
export const OPENCODE2_HOST_PIN = `@opencode-ai/cli@${OPENCODE2_HOST_VERSION}`;
export const OPENCODE2_PLUGIN_VERSION = "0.0.0-dev-18204";
export const OPENCODE2_PLUGIN_PIN = `@opencode-ai/plugin@${OPENCODE2_PLUGIN_VERSION}`;
export const TYPEBOX_PIN = "typebox@1.3.7";

/**
 * The target profile string recorded in `pioc.lock.json` for the generated `generated/pi` output.
 * Matches `@pi-oc2/target-pi`'s own generated-file header exactly (`emit-pi-extension.ts`'s
 * `"// Target profile: pi-0.84.3."` line) — `@pi-oc2/target-pi` does not return a profile value
 * from `generatePiTarget`, so this is `pioc`'s own record of what it was built against, not
 * something read back from the generator.
 */
export const PI_TARGET_PROFILE = "pi-0.84.3";

/**
 * The target profile string recorded in `pioc.lock.json` for the generated `generated/opencode2`
 * output. `port-command.ts` cross-checks this against `@pi-oc2/target-opencode2`'s own returned
 * `targetProfile` at generation time and fails closed on any mismatch — `@pi-oc2/target-opencode2`
 * is a sibling package `pioc` does not own, so this string only stays correct as long as both sides
 * update it together. `promise-tool-domain` names the current contract: a single `Plugin.define({
 * id, setup })` entry point whose `setup(context)` registers tools and skills through
 * `context.tool.transform(...)` / `context.skill.transform(...)`, not a `Hooks`-based export and
 * not separate `.opencode/tools` / `.opencode/skills` files.
 */
export const OPENCODE2_TARGET_PROFILE = "opencode2-dev-18204+plugin-dev-18204+promise-tool-domain";

/** The combined target profile written to `pioc.lock.json`; verification rejects any drift from it. */
export const COMBINED_TARGET_PROFILE = `${PI_TARGET_PROFILE}|${OPENCODE2_TARGET_PROFILE}`;
