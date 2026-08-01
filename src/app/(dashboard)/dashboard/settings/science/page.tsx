"use client";

import { useState, useEffect } from "react";
import { Card } from "@/shared/components";
import { useTranslations } from "next-intl";

type ScienceMode = "off" | "on";
type EvidenceLevel = "none" | "citations" | "citations+references";

interface ScienceConfig {
  mode: ScienceMode;
  evidenceLevel: EvidenceLevel;
  maxTokenBudget: number;
  requireCitations: boolean;
}

const DEFAULT_CONFIG: ScienceConfig = {
  mode: "off",
  evidenceLevel: "citations",
  maxTokenBudget: 4096,
  requireCitations: true,
};

export default function ScienceModePage() {
  const t = useTranslations("settings");
  const [config, setConfig] = useState<ScienceConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetch("/api/settings/science")
      .then((res) => res.json())
      .then((data) => {
        setConfig(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus("");
    try {
      const response = await fetch("/api/settings/science", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!response.ok) throw new Error("Save failed");
      setStatus(t("scienceSaved"));
    } catch {
      setStatus(t("scienceSaveError"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-text-muted">{t("loading")}</p>;

  return (
    <Card title={t("scienceMode")} subtitle={t("scienceSubtitle")} icon="science">
      <div className="space-y-5">
        <div className="flex gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="scienceMode"
              value="off"
              checked={config.mode === "off"}
              onChange={() => setConfig({ ...config, mode: "off" })}
            />
            {t("off")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="scienceMode"
              value="on"
              checked={config.mode === "on"}
              onChange={() => setConfig({ ...config, mode: "on" })}
            />
            {t("on")}
          </label>
        </div>

        {config.mode === "on" && (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-text-main">
                  {t("evidenceLevel")}
                </label>
                <select
                  className="w-full rounded border border-border bg-bg px-3 py-2.5 text-text-main"
                  value={config.evidenceLevel}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      evidenceLevel: e.target.value as EvidenceLevel,
                    })
                  }
                >
                  <option value="none">{t("evidenceNone")}</option>
                  <option value="citations">{t("evidenceCitations")}</option>
                  <option value="citations+references">{t("evidenceCitationsAndRefs")}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-main">
                  {t("maxTokenBudget")}
                </label>
                <input
                  type="number"
                  min={1024}
                  max={32768}
                  className="w-full rounded border border-border bg-bg px-3 py-2.5 text-text-main"
                  value={config.maxTokenBudget}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      maxTokenBudget: Number(e.target.value) || 4096,
                    })
                  }
                />
              </div>
            </div>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={config.requireCitations}
                onChange={(e) => setConfig({ ...config, requireCitations: e.target.checked })}
              />
              <span className="text-sm text-text-main">{t("requireCitations")}</span>
            </label>

            <div className="flex gap-2">
              <button
                className="rounded bg-bg px-4 py-2.5 text-sm text-text-main border border-border hover:border-border-hover"
                onClick={save}
                disabled={saving}
              >
                {saving ? t("saving") : t("saveSettings")}
              </button>
              {status && <span className="text-sm text-text-muted">{status}</span>}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
