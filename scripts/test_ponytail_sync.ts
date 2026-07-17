// REAL verify: compression config -> syncPonytailToSystemPrompt -> injectSystemPrompt
import {
  setSystemPromptConfig,
  getSystemPromptConfig,
  injectSystemPrompt,
} from "../open-sse/services/systemPrompt.ts";
import { syncPonytailToSystemPrompt } from "../open-sse/services/ponytail/applyPonytail.ts";
import { getPonytailRuleset } from "../open-sse/services/ponytail/rulesets.ts";

let pass = true;
function check(name: string, cond: boolean) {
  console.log(`[${cond ? "OK" : "FAIL"}] ${name}`);
  if (!cond) pass = false;
}

// Start clean
setSystemPromptConfig({ enabled: true, prefixPrompt: "", suffixPrompt: "" });

// 1. lite
syncPonytailToSystemPrompt({ enabled: true, level: "lite" });
let cfg = getSystemPromptConfig();
check("lite: suffix set", cfg.suffixPrompt.includes("lazy senior developer"));
check("lite: matches ruleset(lite)", cfg.suffixPrompt === getPonytailRuleset("lite"));
let out = injectSystemPrompt({
  messages: [
    { role: "system", content: "BASE" },
    { role: "user", content: "hi" },
  ],
} as any);
let s = out.messages![0].content as string;
check("lite: injected after base", s.startsWith("BASE") && s.includes("security."));

// 2. full
syncPonytailToSystemPrompt({ enabled: true, level: "full" });
cfg = getSystemPromptConfig();
check("full: matches ruleset(full)", cfg.suffixPrompt === getPonytailRuleset("full"));

// 3. ultra
syncPonytailToSystemPrompt({ enabled: true, level: "ultra" });
cfg = getSystemPromptConfig();
check("ultra: matches ruleset(ultra)", cfg.suffixPrompt === getPonytailRuleset("ultra"));
check("ultra: has zero-tolerance section", cfg.suffixPrompt.includes("zero tolerance for bloat"));

// 4. disabled -> suffix cleared (preserve prefix)
setSystemPromptConfig({ enabled: true, prefixPrompt: "PREFIX", suffixPrompt: "junk" });
syncPonytailToSystemPrompt({ enabled: false, level: "full" });
cfg = getSystemPromptConfig();
check("off: suffix cleared", cfg.suffixPrompt === "");
check("off: prefix preserved", cfg.prefixPrompt === "PREFIX");

// 5. undefined -> treated as off
setSystemPromptConfig({ enabled: true, prefixPrompt: "", suffixPrompt: "junk" });
syncPonytailToSystemPrompt(undefined);
check("undefined: suffix cleared", getSystemPromptConfig().suffixPrompt === "");

console.log(pass ? "\n✅ PONYTAIL SYNC FLOW VERIFIED" : "\n❌ FAILED");
process.exit(pass ? 0 : 1);
