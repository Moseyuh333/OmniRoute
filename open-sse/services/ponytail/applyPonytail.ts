// Sync Ponytail compression config → Global System Prompt suffix.
//
// Ponytail (lazy-senior-dev mode) is configured in the Compression Context panel
// (mirrors cavemanOutputMode). When enabled, its ruleset for the selected level is
// injected as the system-prompt SUFFIX (highest recency priority). When disabled,
// the suffix is cleared so no ponytail text is injected.
//
// Kept separate from systemPrompt.ts on purpose: the authoritative *intent* lives in
// the compression config (so the dashboard toggle drives it); this module is the
// projection that materializes it into the runtime system-prompt config.

import { setSystemPromptConfig, getSystemPromptConfig } from "../systemPrompt.ts";
import { getPonytailRuleset, type PonytailLevel } from "./rulesets.ts";

export function syncPonytailToSystemPrompt(ponytail?: {
  enabled?: boolean;
  level?: PonytailLevel;
}): void {
  const current = getSystemPromptConfig();
  const enabled = ponytail?.enabled === true;
  const level: PonytailLevel = (ponytail?.level as PonytailLevel) || "full";

  if (enabled) {
    setSystemPromptConfig({ suffixPrompt: getPonytailRuleset(level) });
    return;
  }

  // Disabled: clear only the ponytail suffix. Preserve any user-set prefix.
  const prefix = current.prefixPrompt || "";
  if (prefix) {
    setSystemPromptConfig({ prefixPrompt: prefix, suffixPrompt: "" });
  } else {
    setSystemPromptConfig({ suffixPrompt: "" });
  }
}
