// REAL verify: require OmniRoute's actual injectSystemPrompt from source (no replication)
import {
  setSystemPromptConfig,
  injectSystemPrompt,
  getSystemPromptConfig,
} from "../open-sse/services/systemPrompt.ts";

// 1. Load config exactly as server-init.ts does at boot
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.resolve(__dirname, "..", "data", "storage.sqlite");
const db = new Database(DB, { readonly: true });
const row = db
  .prepare("SELECT value FROM key_value WHERE namespace='settings' AND key='systemPrompt'")
  .get() as { value: string } | undefined;
db.close();

if (!row) {
  console.error("FAIL: no systemPrompt row in DB");
  process.exit(1);
}
setSystemPromptConfig(JSON.parse(row.value));

// 2. Confirm in-memory config matches
const cfg = getSystemPromptConfig();
console.log("[config] enabled:", cfg.enabled, "| suffixLen:", (cfg.suffixPrompt || "").length);

// 3. Simulate a real chat request (OpenAI messages format) BEFORE injection
const req = {
  model: "gpt-4o",
  messages: [
    { role: "system", content: "BASE OMNIROUTE SYSTEM INSTRUCTIONS" },
    { role: "user", content: "Build me a date picker component" },
  ],
};

// 4. Run the ACTUAL OmniRoute injection function
const out = injectSystemPrompt(req);

// 5. Assertions
const sys = out.messages![0];
const content = typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);
const ponytailInjected = content.includes("lazy senior developer");
const basePreserved = content.startsWith("BASE OMNIROUTE SYSTEM INSTRUCTIONS");
const suffixAtEnd = content.trimEnd().endsWith("Especially to them.)");
const userUntouched = out.messages![1].content === "Build me a date picker component";

console.log("[assert] base system preserved at start :", basePreserved);
console.log("[assert] ponytail injected               :", ponytailInjected);
console.log("[assert] ponytail at END (suffix priority):", suffixAtEnd);
console.log("[assert] user message untouched           :", userUntouched);

const pass = cfg.enabled && ponytailInjected && basePreserved && suffixAtEnd && userUntouched;
console.log(
  pass ? "\n✅ PONYTAIL INTEGRATION VERIFIED (real injectSystemPrompt)" : "\n❌ VERIFICATION FAILED"
);
process.exit(pass ? 0 : 1);
