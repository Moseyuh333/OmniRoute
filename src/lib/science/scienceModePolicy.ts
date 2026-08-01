"use server";

import { getSettings } from "@/lib/db/settings";
import { logger } from "@/shared/utils/logger";

export type ScienceMode = "off" | "on";
export type EvidenceLevel = "none" | "citations" | "citations+references";

export interface ScienceConfig {
  mode: ScienceMode;
  evidenceLevel: EvidenceLevel;
  maxTokenBudget: number;
  requireCitations: boolean;
}

const DEFAULTS: ScienceConfig = {
  mode: "off",
  evidenceLevel: "citations",
  maxTokenBudget: 4096,
  requireCitations: true,
};

// Regex: matches [N] or [N]:  at position start of a line / bracketed number
const CITATION_PATTERN = /(?:\[\d+\](?:\s*:?|\s*))/g;
// Matches a URL-like reference (http(s):// or www.)
const URL_PATTERN = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
// Matches a DOIs
const DOI_PATTERN = /(?:10\.\d{4,9}\/[^\s]+)/gi;
// Matches arxiv identifiers
const ARXIV_PATTERN = /(?:arxiv\.org\/(?:abs|pdf)\/[0-9a-f.\-]+|arXiv:[0-9a-f.\-]+)/gi;

/**
 * Cached fetch of the science mode config. TTL 10s to avoid hammering the DB
 * on every completion request.
 */
let cachedConfig: ScienceConfig | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 10_000;

export async function getActiveScienceConfig(): Promise<ScienceConfig> {
  const now = Date.now();
  if (cachedConfig && now < cacheExpiry) return cachedConfig;

  try {
    const settings = (await getSettings()) as Record<string, unknown> | null;
    const sci = (settings?.science as ScienceConfig | undefined) ?? {};
    cachedConfig = { ...DEFAULTS, ...sci };
  } catch (error) {
    logger.warn("scienceMode", `Failed to load science config, using defaults: ${error}`);
    cachedConfig = { ...DEFAULTS };
  }
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedConfig;
}

/** Invalidate the science config cache. Call after PATCH to /api/settings/science. */
export function invalidateScienceConfigCache(): void {
  cachedConfig = null;
  cacheExpiry = 0;
}

interface FilterResult {
  ok: boolean;
  reason?: string;
  evidenceScore: number;
  citationCount: number;
  referenceCount: number;
}

/**
 * Evaluate a text answer against the science mode policy.
 * - evidenceScore: 0..1 (fraction of required markers satisfied)
 * - citationCount / referenceCount: raw detected counts
 */
export function evaluateEvidence(text: string): FilterResult {
  const citationCount = (text.match(CITATION_PATTERN) ?? []).length;
  const urlCount = (text.match(URL_PATTERN) ?? []).length;
  const doiCount = (text.match(DOI_PATTERN) ?? []).length;
  const arxivCount = (text.match(ARXIV_PATTERN) ?? []).length;
  const referenceCount = doiCount + arxivCount;
  const totalEvidence = citationCount + referenceCount;
  const evidenceScore = Math.min(1, totalEvidence / 8);
  return { ok: true, evidenceScore, citationCount, referenceCount };
}

/**
 * Filter pipeline for science mode:
 * 1. If mode === "off", pass through unchanged.
 * 2. If mode === "on" && requireCitations, check the answer has at least one citation.
 * 3. evidenceLevel "citations+references": require at least one reference (URL/DOI/arXiv).
 * 4. evidenceLevel "none": pass through.
 *
 * Returns { allowed, reason } so the caller can decide to emit a 406 or re-prompt.
 */
export async function filterAnswerWithSciencePolicy(
  answer: string,
  config: ScienceConfig = DEFAULTS
): Promise<{ allowed: boolean; reason?: string } & Omit<FilterResult, "ok">> {
  if (!config || config.mode !== "on" || !answer) {
    return { allowed: true, evidenceScore: 1, citationCount: 0, referenceCount: 0 };
  }

  const ev = evaluateEvidence(answer);

  if (config.requireCitations && ev.citationCount === 0) {
    return {
      allowed: false,
      reason: "Answer lacks citations [science-mode:requireCitations]",
      ...ev,
    };
  }

  if (config.evidenceLevel === "citations+references" && ev.referenceCount === 0) {
    return {
      allowed: false,
      reason: "Answer lacks verifiable references (URLs/DOI/arXiv) [science-mode:evidenceLevel]",
      ...ev,
    };
  }

  return { allowed: true, ...ev };
}

/**
 * Truncate answer text to fit within `maxTokenBudget` (rough estimate: 1 token ~ 0.75 words
 * in English, so we cut at ~budget*0.75 words). Only applies when science mode is on.
 */
export function enforceTokenBudget(answer: string, budget: number): { text: string; truncated: boolean } {
  if (!budget || budget <= 0) return { text: answer, truncated: false };
  // Rough word-based estimate: assume avg 0.75 words/token.
  const maxWords = Math.max(10, Math.floor(budget * 0.75));
  const words = answer.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { text: answer, truncated: false };
  return { text: words.slice(0, maxWords).join(" ") + " …[truncated:tokenBudget]", truncated: true };
}

/**
 * Build the system-level instruction injected into chat requests when science
 * mode is enabled. Tells the model to back its claims with verifiable citations
 * and to surface references inline, matching the evidenceLevel policy.
 *
 * Designed to be appended to an existing system prompt (or prepended as the
 * sole system message when none exists), so it never clobbers app-level
 * instructions.
 */
export function buildScienceSystemPrompt(config: ScienceConfig): string {
  const evidenceInstructions: Record<EvidenceLevel, string> = {
    none: "Provide concise, factual answers without requiring citations.",
    citations:
      "Support every factual claim with an inline citation in the form [1], [2], etc., " +
      "and include a 'References' section at the end listing the source for each number, " +
      "using author/title/year or a direct URL when available.",
    "citations+references":
      "Support every factual claim with an inline citation [1], [2], etc., and include a " +
      "'References' section listing DOIs, arXiv IDs, or authoritative URLs for each source. " +
      "Only cite sources you can verify exist; do not fabricate references.",
  };

  const citationRule = config.requireCitations
    ? "You MUST include at least one inline citation and reference for every response. "
    : "";

  const budgetHint =
    config.maxTokenBudget && config.maxTokenBudget > 0
      ? `Keep responses within a ${config.maxTokenBudget}-token budget. `
      : "";

  return [
    citationRule,
    budgetHint,
    evidenceInstructions[config.evidenceLevel] ?? evidenceInstructions["citations"],
  ]
    .filter(Boolean)
    .join(" ");
}
