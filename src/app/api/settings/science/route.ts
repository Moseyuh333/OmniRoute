import { NextRequest, NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { z } from "zod";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const scienceConfigSchema = z.object({
  mode: z.enum(["off", "on"]).optional(),
  evidenceLevel: z.enum(["none", "citations", "citations+references"]).optional(),
  maxTokenBudget: z.number().min(1024).max(32768).optional(),
  requireCitations: z.boolean().optional(),
});

type ScienceConfig = {
  mode: "off" | "on";
  evidenceLevel: "none" | "citations" | "citations+references";
  maxTokenBudget: number;
  requireCitations: boolean;
};

const DEFAULTS: ScienceConfig = {
  mode: "off",
  evidenceLevel: "citations",
  maxTokenBudget: 4096,
  requireCitations: true,
};

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const settings = await getSettings();
    const sci = (settings as Record<string, unknown>)?.science as ScienceConfig | undefined;
    return NextResponse.json({ ...DEFAULTS, ...sci });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = validateBody(scienceConfigSchema, rawBody);
    if (isValidationFailure(validation)) {
      return validation.response;
    }

    const body = validation.data;
    const current = ((await getSettings()) as Record<string, unknown>)?.science ?? {};

    const updates: Partial<ScienceConfig> = { ...current };
    if (body.mode !== undefined) updates.mode = body.mode;
    if (body.evidenceLevel !== undefined) updates.evidenceLevel = body.evidenceLevel;
    if (body.maxTokenBudget !== undefined) updates.maxTokenBudget = body.maxTokenBudget;
    if (body.requireCitations !== undefined) updates.requireCitations = body.requireCitations;

    await updateSettings({ science: updates });
    return NextResponse.json({ ok: true, ...updates });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}