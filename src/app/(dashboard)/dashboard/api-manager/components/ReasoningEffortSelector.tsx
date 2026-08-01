"use client";

import { useTranslations } from "next-intl";

type ReasoningEffort = "low" | "medium" | "high" | null;

interface Props {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
}

const EFFORT_OPTIONS: { value: ReasoningEffort; labelKey: string; descKey: string }[] = [
  { value: null, labelKey: "reasoningOff", descKey: "reasoningOffDesc" },
  { value: "low", labelKey: "reasoningLow", descKey: "reasoningLowDesc" },
  { value: "medium", labelKey: "reasoningMedium", descKey: "reasoningMediumDesc" },
  { value: "high", labelKey: "reasoningHigh", descKey: "reasoningHighDesc" },
];

/**
 * Per-API-key reasoning effort selector.
 * Mirrors ChaosModeAccessToggle pattern — extracted from ApiManagerPageClient.tsx.
 */
export function ReasoningEffortSelector({ value, onChange }: Props) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");

  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-surface/40">
      <p className="text-sm font-medium text-text-main">{t("reasoningEffort")}</p>
      <p className="text-xs text-text-muted">{t("reasoningEffortDesc")}</p>
      <div className="flex flex-wrap gap-2">
        {EFFORT_OPTIONS.map((opt) => (
          <button
            key={opt.value ?? "none"}
            type="button"
            role="switch"
            aria-checked={value === opt.value}
            onClick={() => onChange(opt.value)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              value === opt.value
                ? "bg-primary/15 text-primary-700 dark:text-primary-300 border border-primary/30"
                : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
            }`}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}