// Configure Ponytail for OmniRoute (D: drive).
//
// Ponytail is driven from the Compression Context panel (toggle + lite/full/ultra),
// mirroring cavemanOutputMode. This script seeds BOTH sources so it works with or
// without a reboot:
//   1. compression config row `ponytail` = {enabled, level}  → the dashboard source of truth
//   2. systemPrompt suffix = ruleset(level)                  → live runtime injection right now
//
// Usage: node scripts/apply_ponytail.cjs [level]   (level default: full)

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DB = path.join(ROOT, "data", "storage.sqlite");
const RULES = path.join(ROOT, "ponytail_AGENTS.md");

if (!fs.existsSync(DB)) { console.error("DB not found:", DB); process.exit(1); }
if (!fs.existsSync(RULES)) { console.error("Ruleset not found:", RULES); process.exit(1); }

// lite/ultra are derived subsets/supersets; for the one-shot apply we persist the full
// file as the suffix and set the chosen level so the panel matches.
const level = process.argv[2] === "lite" || process.argv[2] === "ultra" ? process.argv[2] : "full";
const fullRules = fs.readFileSync(RULES, "utf8").trim();

const db = new Database(DB, { readonly: false });
db.pragma("busy_timeout = 5000");

// 1. Compression config (dashboard source of truth)
db.prepare(
  "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('compression', 'ponytail', ?)"
).run(JSON.stringify({ enabled: true, level }));

// 2. Live system-prompt suffix (immediate effect)
db.prepare(
  "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'systemPrompt', ?)"
).run(JSON.stringify({ enabled: true, prefixPrompt: "", suffixPrompt: fullRules }));

const c = JSON.parse(db.prepare("SELECT value FROM key_value WHERE namespace='compression' AND key='ponytail'").get().value);
const s = JSON.parse(db.prepare("SELECT value FROM key_value WHERE namespace='settings' AND key='systemPrompt'").get().value);
db.close();

console.log("compression.ponytail :", JSON.stringify(c));
console.log("settings.systemPrompt: enabled=%s suffixLen=%d", s.enabled, (s.suffixPrompt || "").length);
console.log("Ponytail seeded. Dashboard (Compression Context) shows it; reboot re-syncs from compression config.");
