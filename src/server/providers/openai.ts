import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { MoviePlanSchema, type MoviePlan } from "@/domain/movie";
import { env } from "@/server/env";
import { getProviderKey } from "@/server/provider-secrets";
import { query } from "@/server/db";

export const OPENAI_TASK_MODELS = {
  screenwriting: { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", role: "Complex story architecture and direction" },
  prompts: { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", role: "Shot prompts and targeted revisions" },
  qc: { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", role: "High-volume metadata and QC" },
} as const;

export const OPENAI_AVAILABLE_MODELS = [
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
] as const;

export type OpenAITask = keyof typeof OPENAI_TASK_MODELS;

export async function openAIModelRouting(): Promise<Record<OpenAITask, string>> {
  const fallback = { screenwriting: env().OPENAI_SCREENWRITER_MODEL, prompts: env().OPENAI_PROMPT_MODEL, qc: env().OPENAI_QC_MODEL };
  try {
    const rows = await query<{ settings: { openaiModels?: Partial<Record<OpenAITask, string>> } }>("SELECT settings FROM workspace_settings WHERE workspace_id=$1", [env().DEFAULT_WORKSPACE_ID]);
    return { ...fallback, ...(rows[0]?.settings.openaiModels ?? {}) };
  } catch { return fallback; }
}

export async function openAIClient(): Promise<OpenAI> {
  const apiKey = await getProviderKey("openai");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");
  return new OpenAI({ apiKey });
}

export async function testOpenAIConnection(): Promise<{ connected: true; model: string }> {
  const client = await openAIClient();
  await client.models.retrieve(env().OPENAI_SCREENWRITER_MODEL);
  return { connected: true, model: env().OPENAI_SCREENWRITER_MODEL };
}

export interface ProjectContextBundle {
  projectId?: string;
  durationSeconds: number;
  selectedSceneId?: string;
  screenplaySummary?: string;
  relevantCharacters?: unknown[];
  relevantLocations?: unknown[];
  recentSceneStates?: unknown[];
  lockedValues?: Record<string, unknown>;
  userEdits?: unknown[];
}

export async function generateStructuredMoviePlan(input: {
  projectId: string;
  idea: string;
  durationSeconds: number;
  modelId?: string;
}): Promise<MoviePlan> {
  const client = await openAIClient();
  const response = await client.responses.parse({
    model: input.modelId ?? (await openAIModelRouting()).screenwriting,
    reasoning: { effort: "high" },
    instructions: SCREENWRITER_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Create a production-ready MoviePlan for project ${input.projectId}. Exact target runtime: ${input.durationSeconds} seconds. User idea: ${input.idea}`,
          },
        ],
      },
    ],
    text: { format: zodTextFormat(MoviePlanSchema, "movie_plan") },
    max_output_tokens: 120_000,
  });
  const parsed = (response as typeof response & { output_parsed?: MoviePlan }).output_parsed;
  if (!parsed) throw new Error("OpenAI returned no structured MoviePlan.");
  return MoviePlanSchema.parse(parsed);
}

export async function enhanceShotPrompt(input: {
  original: string;
  modelId: string;
  context: ProjectContextBundle;
}): Promise<{ original: string; enhanced: string }> {
  const client = await openAIClient();
  const schema = z.object({ original: z.string(), enhanced: z.string() });
  const response = await client.responses.parse({
    model: (await openAIModelRouting()).prompts,
    reasoning: { effort: "medium" },
    instructions: "Improve a video-generation prompt while preserving its exact narrative intent. Never add characters, dialogue or plot events. Respect every locked project value.",
    input: JSON.stringify(input),
    text: { format: zodTextFormat(schema, "enhanced_prompt") },
  });
  const parsed = (response as typeof response & { output_parsed?: z.infer<typeof schema> }).output_parsed;
  if (!parsed) throw new Error("OpenAI returned no enhanced prompt.");
  return parsed;
}

export async function proposeDialogueEdit(input: {
  command: string;
  dialogue: { id: string; characterId: string; characterName: string; text: string; delivery: string };
  context: ProjectContextBundle;
}): Promise<{ text: string; delivery: string }> {
  const client = await openAIClient();
  const schema = z.object({ text: z.string(), delivery: z.string() });
  const response = await client.responses.parse({
    model: (await openAIModelRouting()).prompts,
    reasoning: { effort: "low" },
    instructions: "Apply the user's requested change to exactly one dialogue line. Preserve meaning, character voice and all unaffected words when possible. Return only the revised exact text and delivery.",
    input: JSON.stringify(input),
    text: { format: zodTextFormat(schema, "dialogue_edit") },
  });
  const parsed = (response as typeof response & { output_parsed?: z.infer<typeof schema> }).output_parsed;
  if (!parsed) throw new Error("OpenAI returned no dialogue revision.");
  return parsed;
}

export const ShotQcSchema = z.object({
  characterConsistency: z.number().min(0).max(100),
  locationConsistency: z.number().min(0).max(100),
  dialogueAccuracy: z.number().min(0).max(100),
  visualQuality: z.number().min(0).max(100),
  continuity: z.number().min(0).max(100),
  promptCompliance: z.number().min(0).max(100),
  audioQuality: z.number().min(0).max(100),
  overall: z.number().min(0).max(100),
  issues: z.array(z.string()),
  retryInstruction: z.string().nullable(),
});

export type ShotQcReport = z.infer<typeof ShotQcSchema>;

export async function evaluateShot(input: {
  expected: unknown;
  generatedMetadata: unknown;
  projectMemory: unknown;
  previewImageDataUrl?: string;
}): Promise<ShotQcReport> {
  const client = await openAIClient();
  const { previewImageDataUrl, ...evidence } = input;
  const response = await client.responses.parse({
    model: (await openAIModelRouting()).qc,
    reasoning: { effort: "low" },
    instructions: "You are a film continuity QC system. Score only from supplied evidence. If evidence is unavailable, flag it instead of inventing observations. A retry instruction must target only the failing shot and preserve unaffected content.",
    input: [{ role: "user", content: [
      { type: "input_text" as const, text: JSON.stringify(evidence) },
      ...(previewImageDataUrl ? [{ type: "input_image" as const, image_url: previewImageDataUrl, detail: "low" as const }] : []),
    ] }],
    text: { format: zodTextFormat(ShotQcSchema, "shot_qc") },
  });
  const parsed = (response as typeof response & { output_parsed?: ShotQcReport }).output_parsed;
  if (!parsed) throw new Error("OpenAI returned no QC report.");
  return parsed;
}

export async function createScreenwriterStream(input: {
  message: string;
  previousResponseId?: string;
  context: ProjectContextBundle;
  mode: "screenwriter" | "director";
  modelId?: string;
  attachments?: string[];
}) {
  const client = await openAIClient();
  return client.responses.create({
    model: input.modelId ?? (await openAIModelRouting()).screenwriting,
    stream: true,
    previous_response_id: input.previousResponseId,
    reasoning: { effort: input.mode === "director" ? "high" : "medium" },
    instructions: input.mode === "director" ? DIRECTOR_INSTRUCTIONS : SCREENWRITER_CHAT_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text" as const, text: `PROJECT CONTEXT\n${JSON.stringify(input.context)}\n\nUSER\n${input.message}` },
          ...(input.attachments ?? []).map((imageUrl) => ({ type: "input_image" as const, image_url: imageUrl, detail: "auto" as const })),
        ],
      },
    ],
    tools: [
      {
        type: "function",
        name: "create_movie_from_current_screenplay",
        description: "Prepare the current screenplay as a Movie Project. This action never starts paid generation; it returns a cost confirmation plan.",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: ["string", "null"] },
            durationSeconds: { type: "number" },
            modelId: { type: "string" },
            resolution: { type: "string" },
          },
          required: ["projectId", "durationSeconds", "modelId", "resolution"],
        },
      },
    ],
  });
}

const SCREENWRITER_INSTRUCTIONS = `You are CineForge's production screenwriter. Return a strict MoviePlan only.
The screenplay must have meaningful dramatic content for the full target runtime without repeated shots, artificial slow motion, filler, reused dialogue or padding.
Every scene and shot requires stable IDs. Every shot must be short enough for the chosen Google video model (maximum 10 seconds).
Build character, location, wardrobe, voice, audio and continuity state explicitly. Dialogue text is exact. Audio contexts start clean unless carry-over is intentional.
Locked values must never change without a direct user request. The total of shot durations should closely match the requested runtime.`;

const SCREENWRITER_CHAT_INSTRUCTIONS = `You are CineForge AI Screenwriter. Help develop titles, concepts, characters, acts, scenes, dialogue and production-ready screenplays.
Use the supplied project context and never mix facts between projects. Make targeted changes: when the user asks to change one scene or ending, preserve unaffected content and explain the affected range.
When the user asks to start generation, call create_movie_from_current_screenplay. That tool only prepares a plan; paid video generation always needs explicit UI confirmation.`;

const DIRECTOR_INSTRUCTIONS = `You are CineForge AI Director. Reason from the supplied screenplay, Project Memory, locked values, shot states and continuity evidence.
Prefer minimal impact. Never regenerate unaffected content. For every proposed edit identify scene_id, shot_id, affected tracks/frames and unaffected range.
Do not start paid video generation directly. Use create_movie_from_current_screenplay only to prepare a cost confirmation plan.`;
