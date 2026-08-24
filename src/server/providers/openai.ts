import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { MoviePlanSchema, MoviePlanStructuredOutputSchema, moviePlanFromStructuredOutput, type MoviePlan } from "@/domain/movie";
import { env } from "@/server/env";
import { getProviderKey } from "@/server/provider-secrets";
import { query } from "@/server/db";
import { discoverGoogleModels } from "@/server/providers/video/google";

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

export async function testOpenAIConnection(candidateApiKey?: string): Promise<{ connected: true; model: string }> {
  const client = candidateApiKey ? new OpenAI({ apiKey: candidateApiKey }) : await openAIClient();
  await client.models.retrieve(env().OPENAI_SCREENWRITER_MODEL);
  return { connected: true, model: env().OPENAI_SCREENWRITER_MODEL };
}

export async function transcribeMovieDescription(file: File): Promise<string> {
  try {
    const client = await openAIClient();
    const result = await client.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe",
      language: "ru",
      response_format: "json",
      prompt: "Точное описание идеи фильма на русском языке. Сохраняй имена, жанры, длительность, реплики и кинематографические термины.",
    });
    return result.text.trim();
  } catch (openAIError) {
    try {
      const apiKey = await getProviderKey("google");
      if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
      const data = Buffer.from(await file.arrayBuffer()).toString("base64");
      let lastError: unknown;
      for (const model of await selectGeminiFallbackModels(apiKey)) {
        try {
          const payload = await callGeminiGenerateContent(apiKey, model, {
            contents: [{ role: "user", parts: [
              { inlineData: { mimeType: file.type || "audio/webm", data } },
              { text: "Точно расшифруй речь на русском языке. Верни только произнесённый текст без пояснений, кавычек и markdown." },
            ] }],
          });
          return geminiText(payload).trim();
        } catch (error) { lastError = error; }
      }
      throw lastError ?? new Error("Google API не предоставил резервную Gemini Flash модель.");
    } catch (geminiError) {
      throw combinedProviderError("распознавание речи", openAIError, geminiError);
    }
  }
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
  screenwriterModelId?: string;
  videoModelId?: string;
  fastDraft?: boolean;
}): Promise<MoviePlan> {
  // A ten-second draft is exactly one provider shot. Expanding it through a
  // long-form screenplay model adds latency without adding usable scene graph
  // structure, so preserve the complete user prompt in a real one-shot plan
  // and let the model-specific prompt adapter direct it immediately.
  if (input.fastDraft && input.durationSeconds <= 10) return createExpressDraftMoviePlan(input);
  try {
    const client = await openAIClient();
    const routing = await openAIModelRouting();
    const response = await client.responses.parse({
      // A short Fast Draft needs the same strict schema but not the latency of
      // the flagship long-form dramaturgy model. Users can still override it.
      model: input.screenwriterModelId ?? (input.fastDraft && input.durationSeconds <= 60 ? routing.qc : input.fastDraft && input.durationSeconds <= 300 ? routing.prompts : routing.screenwriting),
      reasoning: { effort: input.durationSeconds <= 60 ? "low" : input.durationSeconds <= 300 ? "medium" : "high" },
      instructions: SCREENWRITER_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: moviePlanRequest(input),
            },
          ],
        },
      ],
      text: { format: zodTextFormat(MoviePlanStructuredOutputSchema, "movie_plan") },
      max_output_tokens: Math.min(120_000, Math.max(12_000, 8_000 + Math.ceil(input.durationSeconds / 5) * 900)),
    }, input.fastDraft ? { timeout: 35_000, maxRetries: 0 } : undefined);
    const parsed = (response as typeof response & { output_parsed?: unknown }).output_parsed;
    if (!parsed) throw new Error("OpenAI returned no structured MoviePlan.");
    return moviePlanFromStructuredOutput(parsed);
  } catch (openAIError) {
    try {
      const apiKey = await getProviderKey("google");
      if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
      let lastError: unknown;
      for (const model of await selectGeminiFallbackModels(apiKey)) {
        try {
          const payload = await callGeminiGenerateContent(apiKey, model, {
            systemInstruction: { parts: [{ text: SCREENWRITER_INSTRUCTIONS }] },
            contents: [{ role: "user", parts: [{ text: moviePlanRequest(input) }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: z.toJSONSchema(MoviePlanStructuredOutputSchema),
              maxOutputTokens: Math.min(65_536, Math.max(12_000, 8_000 + Math.ceil(input.durationSeconds / 5) * 900)),
            },
          });
          const parsed = MoviePlanStructuredOutputSchema.parse(JSON.parse(geminiText(payload)));
          return moviePlanFromStructuredOutput(parsed);
        } catch (error) { lastError = error; }
      }
      throw lastError ?? new Error("Google API не предоставил резервную Gemini Flash модель.");
    } catch (geminiError) {
      throw combinedProviderError("создание сценария", openAIError, geminiError);
    }
  }
}

export function createExpressDraftMoviePlan(input: {
  projectId: string;
  idea: string;
  durationSeconds: number;
}): MoviePlan {
  const idea = input.idea.trim();
  const durationSeconds = Math.max(1, Math.min(10, input.durationSeconds));
  const sceneId = "express-scene-1";
  const shotId = "express-shot-1";
  const locationId = "express-location-1";
  const characterId = "express-character-1";
  const wardrobeId = "express-wardrobe-1";
  const dialogueText = firstQuotedDialogue(idea);
  const hasCharacter = Boolean(dialogueText) || /(?:человек|мужчин|женщин|девуш|парень|геро|персонаж|агент|полицей|солдат|реб[её]нок|man|woman|person|character|agent|officer|soldier|child)\w*/i.test(idea);
  const characterIds = hasCharacter ? [characterId] : [];
  const characterStates = hasCharacter ? {
    [characterId]: {
      locationId,
      wardrobeId,
      heldProps: [],
      injuries: [],
      appearanceChanges: [],
      position: "в точной позиции, заданной пользователем; остаётся на той же физически достижимой стороне всех стен и дверей",
      emotionalState: "точно по запросу пользователя",
    },
  } : {};
  const dialogue = dialogueText && hasCharacter ? [{
    id: "express-dialogue-1",
    characterId,
    characterName: "Главный персонаж",
    text: dialogueText,
    startSeconds: 0,
    durationSeconds: Math.min(durationSeconds, Math.max(1, dialogueText.length / 12)),
    delivery: "естественно, в соответствии с запросом",
  }] : [];

  return MoviePlanSchema.parse({
    id: "express-plan-1",
    projectId: input.projectId,
    summary: {
      title: idea.slice(0, 64) || "Новый фильм",
      genre: "короткометражный фильм",
      style: "фотореалистичная игровая киносъёмка",
      mood: "в соответствии с запросом пользователя",
      durationSeconds,
      logline: idea,
      synopsis: idea,
    },
    characters: hasCharacter ? [{
      id: characterId,
      name: "Главный персонаж",
      age: 30,
      gender: "как указано пользователем",
      face: "точно соответствует описанию пользователя и остаётся неизменным",
      hair: "точно соответствует описанию пользователя",
      height: "естественный рост по запросу",
      build: "естественное телосложение по запросу",
      wardrobe: [{
        id: wardrobeId,
        label: "Образ из запроса",
        clothing: ["точно указанная пользователем одежда без самовольных изменений"],
        shoes: "соответствуют образу",
        accessories: [],
        validFromSceneId: sceneId,
        validToSceneId: null,
      }],
      voice: {
        description: "естественный постоянный голос по запросу",
        speechPattern: "естественная речь",
        provider: null,
        providerVoiceId: null,
      },
      personality: "в соответствии с запросом пользователя",
      backstory: "не добавлять факты, которых нет в запросе",
      relationships: {},
      referenceAssetIds: [],
      locks: { appearance: true, voice: true, outfit: true },
    }] : [],
    locations: [{
      id: locationId,
      name: "Локация из запроса",
      appearance: idea,
      architecture: "точно по запросу; непрерывная реальная геометрия без смены места",
      furniture: [],
      objectLayout: { persistentWorld: "все появившиеся объекты сохраняют положение и не исчезают" },
      defaultLighting: "естественное кинематографическое освещение по запросу",
      defaultWeather: "погода из запроса без внезапной смены",
      timeOfDay: "время суток из запроса без внезапной смены",
      importantDetails: ["реальная физика", "никаких телепортаций", "никаких проходов сквозь твёрдые объекты"],
      referenceAssetIds: [],
      designLocked: true,
    }],
    acts: [{ id: "express-act-1", number: 1, title: "Единый кадр", purpose: idea, startSceneNumber: 1, endSceneNumber: 1 }],
    scenes: [{
      id: sceneId,
      actId: "express-act-1",
      sequenceId: "express-sequence-1",
      number: 1,
      title: "Единая сцена",
      durationSeconds,
      locationId,
      characterIds,
      action: `${idea}. Показать содержательное непрерывное действие с 00:00 до 00:${String(Math.ceil(durationSeconds)).padStart(2, "0")}; без монтажных склеек, повторов и пустого времени.`,
      emotionalBeat: "точно по запросу пользователя",
      lighting: "фотореалистичное естественное освещение",
      sound: "чистый синхронный звук текущей сцены",
      music: null,
      timeOfDay: "как указано пользователем",
      weather: "как указано пользователем",
      continuityRequirements: ["один непрерывный кадр", "реальная физика", "сохранять внешность, одежду, объекты и пространство"],
      shots: [{
        id: shotId,
        sceneId,
        sequence: 1,
        title: "Экспресс-кадр",
        durationSeconds,
        action: idea,
        visualStyle: "photorealistic live-action cinema, natural real-world physics",
        camera: { shotSize: "кинематографический общий или средний план по смыслу", angle: "естественная точка наблюдения", lens: "35mm", movement: "одно плавное мотивированное движение без скачков", framing: "естественная композиция, никто не смотрит в камеру", fps: 24 },
        lighting: "естественное кинематографическое освещение без скачков экспозиции",
        audioContext: {
          cleanStart: true,
          speakers: dialogue.length ? [characterId] : [],
          silentCharacters: dialogue.length ? [] : characterIds,
          dialogue,
          ambience: ["естественная атмосфера локации текущего кадра"],
          soundEffects: ["только синхронные звуки видимых действий"],
          musicCue: null,
          forbidCarryOver: ["любая речь из других кадров", "старая музыка", "посторонние голоса"],
        },
        continuity: {
          characterStates,
          locationId,
          locationState: {
            timeOfDay: "как указано пользователем",
            weather: "как указано пользователем",
            lighting: "стабильное естественное освещение",
            objectPositions: { persistentWorld: "сохраняется на протяжении всего кадра" },
          },
          previousShotId: null,
          nextShotId: null,
          requiredReferences: [],
          lockedValues: { realism: "photorealistic live action", physics: "ordinary real-world physics", userIntent: idea },
        },
        dependencies: [],
        generationPrompt: null,
      }],
    }],
    createdAt: new Date().toISOString(),
  });
}

function firstQuotedDialogue(idea: string): string | null {
  const match = idea.match(/«([^»]{1,240})»|[“"]([^”"]{1,240})[”"]/u);
  return (match?.[1] ?? match?.[2] ?? "").trim() || null;
}

function moviePlanRequest(input: { projectId: string; idea: string; durationSeconds: number; videoModelId?: string }): string {
  const shotLimit = input.videoModelId?.startsWith("gemini-omni")
    ? "For Gemini Omni Flash, make every shot at most 10 seconds and include exact 00:00-00:SS action timing so the Movie Engine can guarantee the requested total runtime with fewer provider calls."
    : "Make every shot at most 8 seconds and use only 4, 6 or 8 second provider beats where practical.";
  return `Create a production-ready MoviePlan for project ${input.projectId}. Exact target runtime: ${input.durationSeconds} seconds. The sum of all shot durationSeconds must equal exactly ${input.durationSeconds}; never return a shorter plan. ${shotLimit} User idea: ${input.idea}`;
}

async function selectGeminiFallbackModels(apiKey: string): Promise<string[]> {
  const models = await discoverGoogleModels(apiKey);
  const usable = models.filter((model) => (model.supportedGenerationMethods ?? []).includes("generateContent"));
  const discovered = usable.map((model) => model.name.replace(/^models\//, ""))
    .filter((id) => /^gemini-.*flash/i.test(id) && !/image|tts|live|audio/i.test(id));
  const availableIds = new Set(discovered);
  const preferred = ["gemini-2.5-flash", "gemini-3.7-flash", "gemini-2.5-flash-lite", "gemini-3.6-flash", "gemini-3.5-flash"];
  const ordered = [...preferred.filter((id) => availableIds.has(id)), ...discovered.filter((id) => !preferred.includes(id))];
  if (!ordered.length) throw new Error("Google API не предоставил текстовую Gemini Flash модель для резервного сценариста.");
  return ordered.slice(0, 4);
}

async function callGeminiGenerateContent(apiKey: string, model: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`Google Gemini ${model}: ${text.slice(0, 1_000)}`), { status: response.status });
  return JSON.parse(text) as Record<string, unknown>;
}

function geminiText(payload: Record<string, unknown>): string {
  const candidates = payload.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
  const text = candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) throw new Error("Google Gemini не вернул текстовый результат.");
  return text;
}

function combinedProviderError(task: string, openAIError: unknown, geminiError: unknown): Error {
  const openAIMessage = openAIError instanceof Error ? openAIError.message : String(openAIError);
  const geminiMessage = geminiError instanceof Error ? geminiError.message : String(geminiError);
  const error = new Error(`Не удалось выполнить ${task}. OpenAI: ${openAIMessage}. Резервный Google Gemini: ${geminiMessage}.`);
  const status = typeof geminiError === "object" && geminiError && "status" in geminiError ? Number((geminiError as { status: unknown }).status) : undefined;
  if (status) Object.assign(error, { status });
  return error;
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
  physicalPlausibility: z.number().min(0).max(100),
  objectPermanence: z.number().min(0).max(100),
  boundaryIntegrity: z.number().min(0).max(100),
  motionContinuity: z.number().min(0).max(100),
  promptCompliance: z.number().min(0).max(100),
  audioQuality: z.number().min(0).max(100),
  overall: z.number().min(0).max(100),
  severePhysicalViolation: z.boolean(),
  observedPhysicalViolations: z.array(z.string()),
  issues: z.array(z.string()),
  retryInstruction: z.string().nullable(),
});

export type ShotQcReport = z.infer<typeof ShotQcSchema>;

export async function evaluateShot(input: {
  expected: unknown;
  generatedMetadata: unknown;
  projectMemory: unknown;
  previewImages?: Array<{ label: string; imageDataUrl: string }>;
}): Promise<ShotQcReport> {
  const client = await openAIClient();
  const { previewImages = [], ...evidence } = input;
  const response = await client.responses.parse({
    model: (await openAIModelRouting()).qc,
    reasoning: { effort: "low" },
    instructions: `You are a strict film continuity and physical-world QC system.
The images are labelled and ordered chronologically: optional PREVIOUS_SHOT_FINAL, then CURRENT_START, CURRENT_MIDDLE and CURRENT_END. Compare the actual visual evidence across time, not just one composition.
Mark severePhysicalViolation=true only when directly visible: an impossible displacement or teleport; a person/object passing through or intersecting a wall, closed door, vehicle or other solid body; a persistent object appearing/disappearing; an unexplained location replacement at a continuous boundary; or physically impossible anatomy/motion. Do not call a motivated camera move or an explicitly planned hard cut a severe violation.
Score only from supplied evidence. If evidence is insufficient, add an issue but do not invent an observation. A retry instruction must repair only this shot, begin from the exact previous endpoint when supplied, and preserve every unaffected identity, voice, costume, object, location and timeline segment.`,
    input: [{ role: "user", content: [
      { type: "input_text" as const, text: JSON.stringify(evidence) },
      ...previewImages.flatMap((preview) => [
        { type: "input_text" as const, text: `VISUAL EVIDENCE ${preview.label}` },
        { type: "input_image" as const, image_url: preview.imageDataUrl, detail: "low" as const },
      ]),
    ] }],
    text: { format: zodTextFormat(ShotQcSchema, "shot_qc") },
  }, { timeout: 20_000, maxRetries: 0 });
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
Write every user-visible field in the language of the user's idea. If the language is Russian, all titles, descriptions, actions, dialogue, camera notes, sound notes and continuity descriptions must be in Russian. Keep only stable IDs and provider model IDs in ASCII.
The screenplay must have meaningful dramatic content for the full target runtime without repeated shots, artificial slow motion, filler, reused dialogue or padding.
Every scene and shot requires stable IDs. Every shot must be short enough for the chosen Google video model (maximum 10 seconds).
Build character, location, wardrobe, voice, audio and continuity state explicitly. Dialogue text is exact. Every audio context starts clean and forbids prior dialogue, prior music and prior sound effects unless the screenplay explicitly requests a continuous sound bridge.
Link every chronologically adjacent shot with previousShotId and nextShotId. The default is one continuous boundary: add the previous shot as a scheduling dependency and begin from its exact final frame. Use a hard cut only when the story truly needs another place or time, and explicitly write the journey, elapsed time or editorial cut in the scene action and continuity requirements. Never invent a new location merely to vary a camera angle. A true cut keeps chronological memory but may render independently. A continuous next shot must begin from the exact end state of the previous shot: character and vehicle positions, movement direction, wardrobe, props, injuries, weather, time, lighting, location layout and unfinished dialogue.
Write every character position as a topological blocking state, including inside/outside, side of wall or doorway, foreground/background, facing direction and intended travel path. A position may change only through a visible physically reachable path. For door actions, explicitly identify who is on each side, who can reach which handle and in which direction the hinged door moves. Never script an impossible side change, passage through solid geometry or unexplained teleport. Use natural eyelines toward scene partners, props or travel direction; nobody looks into the camera unless direct address is explicitly requested.
Treat every recurring vehicle, prop and background object as persistent state in locationState.objectPositions. Record vehicle count, convoy order, model/color, lane or curb offset, heading, wheel orientation, speed and stopped/moving state. Never remove or reposition an object between adjacent shots unless the screenplay visibly shows its continuous movement or removal. For continuous action, preserve screen direction and the 180-degree camera axis; do not invent a reverse angle or camera reset that changes geography.
When the user names a fictional screen character, never rely on the proper name alone. Translate the requested character into stable, concrete visual traits: adult apparent age, face shape without naming a real actor, hair, build, signature costume colors/materials, helmet or accessories, silhouette and voice manner. Lock face, outfit and voice by default. For example, Mysterio must retain the recognizable emerald segmented illusionist armor, deep purple cape with gold clasps, metallic bracers and opaque glowing glass fishbowl helmet/silhouette in every applicable shot; do not randomly change ethnicity or costume. If user reference images exist, treat them as the highest-priority visual identity evidence while still obeying provider policy.
Dialogue continuity is semantic but audio is isolated per clip: record the exact completed/unfinished conversational turn in the shot state, start the next shot with the correct next speaker and response, and never repeat a line that already finished. A clean audio start means no leaked waveform from the prior generated clip; it does not reset the story conversation, established character voice or speaking manner.
Locked values must never change without a direct user request. The total of shot durations should closely match the requested runtime.`;

const SCREENWRITER_CHAT_INSTRUCTIONS = `You are CineForge AI Screenwriter. Help develop titles, concepts, characters, acts, scenes, dialogue and production-ready screenplays.
Always answer in the user's language; default to Russian when the project language is unclear.
Use the supplied project context and never mix facts between projects. Make targeted changes: when the user asks to change one scene or ending, preserve unaffected content and explain the affected range.
When the user asks to start generation, call create_movie_from_current_screenplay. That tool only prepares a plan; paid video generation always needs explicit UI confirmation.`;

const DIRECTOR_INSTRUCTIONS = `You are CineForge AI Director. Reason from the supplied screenplay, Project Memory, locked values, shot states and continuity evidence.
Always answer in the user's language; default to Russian when the project language is unclear.
Prefer minimal impact. Never regenerate unaffected content. For every proposed edit identify scene_id, shot_id, affected tracks/frames and unaffected range.
Do not start paid video generation directly. Use create_movie_from_current_screenplay only to prepare a cost confirmation plan.`;
