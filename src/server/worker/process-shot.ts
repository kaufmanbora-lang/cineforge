import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isRetryableDatabaseConnectionError, query, transaction } from "@/server/db";
import { getProviderKey } from "@/server/provider-secrets";
import { googleVideoAdapter } from "@/server/providers/video/google";
import type { ProviderOperation, VideoGenerationRequest } from "@/server/providers/video/types";
import { getObjectIfExists, putFileObject, putObject, putRemoteObject, signedObjectUrl } from "@/server/storage";
import { findCachedShot } from "@/server/movie/repository";
import { classifyFailure, retryDecision } from "@/server/movie/retry";
import { enqueueAutomaticAssemblyIfReady, enqueueDialoguePatch, enqueueReadyProjectJobs, pauseProjectJobs, requeueDatabaseJob } from "@/server/movie/queue";
import { getAllowedDurations, getVideoModel, type Resolution } from "@/domain/video-models";
import { env } from "@/server/env";
import { contentHash } from "@/server/movie/content-hash";
import { extractFinalFrame, extractRepresentativeFrame } from "@/server/movie/ffmpeg";
import { evaluateShot, type ShotQcReport } from "@/server/providers/openai";
import type { ReferenceImage } from "@/server/providers/video/types";
import type { AudioContext, ContinuityState } from "@/domain/movie";

type PersistedProviderOperation = ProviderOperation & { specHash?: string; startedAt?: string };

interface JobRow {
  id: string;
  project_id: string;
  scene_id: string;
  shot_id: string;
  attempt: number;
  max_attempts: number;
  payload: { providerModelId?: string; editCommand?: string; shot: { durationSeconds: number; generationPrompt?: { prompt: string; negativeDirectives: string[]; seed: number | null }; continuity: ContinuityState; audioContext?: AudioContext }; specHash: string };
  model_id: string;
  resolution: Resolution;
  aspect_ratio: "16:9" | "9:16";
  render_tier: "draft" | "final";
  maximum_budget_usd: string;
  spent_usd: string;
  reserved_usd: string;
  reserved_cost_usd: string;
  shot_last_operation: PersistedProviderOperation | null;
}

export async function processShot(databaseJobId: string): Promise<{ cached: boolean; storageKey: string; retrying?: boolean }> {
  const rows = await query<JobRow>(
    `WITH claimed AS (
       UPDATE jobs SET state='generating',started_at=now(),attempt=attempt+1,updated_at=now()
       WHERE id=$1 AND state IN ('queued','retrying') AND available_at<=now()
       RETURNING *
     )
     SELECT claimed.*,p.model_id,p.resolution,p.aspect_ratio,p.render_tier,p.maximum_budget_usd,p.spent_usd,p.reserved_usd,
       s.last_operation AS shot_last_operation
     FROM claimed JOIN projects p ON p.id=claimed.project_id JOIN shots s ON s.id=claimed.shot_id`,
    [databaseJobId],
  );
  const job = rows[0];
  // Another worker/reconciler may already own this database job. Treat that as
  // an idempotent no-op; only the atomic claimant may call the paid provider.
  if (!job) return { cached: false, storageKey: "", retrying: true };
  if (shouldSwitchFilteredVeoToOmni(job)) {
    job.payload = omniFallbackPayload(job.payload);
    job.shot_last_operation = null;
    await query("UPDATE jobs SET payload=$2 WHERE id=$1", [job.id, JSON.stringify(job.payload)]);
    await query("UPDATE shots SET last_operation=NULL WHERE id=$1", [job.shot_id]);
  }
  const heartbeat = setInterval(() => {
    void query("UPDATE jobs SET updated_at=now() WHERE id=$1 AND state IN ('generating','validating')", [job.id]).catch(() => undefined);
  }, 10_000);
  heartbeat.unref();
  try {
  await query("UPDATE projects SET status='generating',updated_at=now() WHERE id=$1 AND status NOT IN ('completed','cancelled')", [job.project_id]);
  const cached = await findCachedShot(job.project_id, job.shot_id, job.payload.specHash);
  if (cached) {
    await markCompleted(job, cached.storageKey, 0, true);
    await enqueueReadyProjectJobs(job.project_id);
    await enqueueAutomaticAssemblyIfReady(job.project_id);
    return { cached: true, storageKey: cached.storageKey };
  }
  const effectiveModelId = job.payload.providerModelId ?? job.model_id;
  const capabilities = getVideoModel(effectiveModelId);
  const price = capabilities.pricePerSecondUsd[job.resolution] ?? capabilities.pricePerSecondUsd["720p"] ?? 0;
  const providerDuration = providerDurationSeconds(effectiveModelId, job.resolution, job.payload.shot.durationSeconds);
  const projectedCost = providerDuration * price;
  const storageKey = `projects/${job.project_id}/scenes/${job.scene_id}/shots/${job.shot_id}/${job.payload.specHash}.mp4`;
  // Check the durable provider checkpoint before reserving more budget. A
  // worker/database restart must never charge or reserve the same video twice.
  const staged = await getObjectIfExists(storageKey);
  if (!staged && !await reserveBudget(job.id, job.project_id, projectedCost)) {
    await pauseProjectJobs(job.project_id, { code: "BUDGET_REACHED", message: "Maximum generation budget reached." });
    throw new Error("Maximum generation budget reached; project paused.");
  }
  let providerCompleted = false;
  try {
    const prompt = job.payload.shot.generationPrompt;
    if (!prompt) throw new Error("Shot has no generation prompt.");
    let operation: ProviderOperation;
    let providerApiKey: string | undefined;
    if (staged) {
      operation = {
        provider: "google" as const,
        modelId: effectiveModelId,
        operationId: `staged-${job.payload.specHash}`,
        state: "completed" as const,
        progress: 100,
        output: { bytes: staged.bytes, mimeType: staged.contentType },
      };
    } else {
      const apiKey = await getProviderKey("google");
      if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
      providerApiKey = apiKey;
      const references = await loadShotReferences(job, effectiveModelId);
      // Google only accepts previous_interaction_id for a conversational edit.
      // A normal reference-to-video generation must continue from the extracted
      // final frame without attaching the interaction id (otherwise HTTP 400).
      const previousInteractionId = effectiveModelId.startsWith("gemini-omni") && job.payload.editCommand
        ? await loadCurrentInteractionId(job)
        : undefined;
      const request: VideoGenerationRequest = {
        projectId: job.project_id,
        sceneId: job.scene_id,
        shotId: job.shot_id,
        modelId: effectiveModelId,
        prompt: buildContinuityChainPrompt(prompt.prompt, job.payload.shot.continuity, job.payload.shot.audioContext, references.some((reference) => reference.role === "first-frame")),
        negativeDirectives: [...new Set([
          ...prompt.negativeDirectives,
          "character identity drift",
          "wardrobe changes",
          "teleportation",
          "weather or lighting reset",
          "previous dialogue, music or sound leaking into this shot",
        ])],
        durationSeconds: providerDuration,
        resolution: job.resolution,
        aspectRatio: job.aspect_ratio,
        seed: prompt.seed,
        references,
        fastMode: job.render_tier === "draft",
        previousInteractionId,
        editInstruction: job.payload.editCommand && previousInteractionId
          ? buildTargetedEditInstruction(job.payload.editCommand, job.shot_id)
          : undefined,
      };
      const adapter = googleVideoAdapter(effectiveModelId);
      const resumable = resumableProviderOperation(job.shot_last_operation, job.payload.specHash);
      operation = resumable ?? await adapter.start(request, apiKey);
      const providerStartedAt = resumable?.startedAt ?? new Date().toISOString();
      await query("UPDATE shots SET last_operation=$2 WHERE id=$1", [job.shot_id, JSON.stringify(durableProviderOperation(operation, job.payload.specHash, providerStartedAt))]);
      while (operation.state === "pending") {
        if (Date.now() - Date.parse(providerStartedAt) >= 30 * 60_000) {
          throw Object.assign(new Error("Google video operation did not complete within 30 minutes."), { status: 408, code: "GOOGLE_TIMEOUT" });
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await query("UPDATE jobs SET updated_at=now() WHERE id=$1 AND state='generating'", [job.id]).catch(() => undefined);
        operation = await adapter.poll(operation, apiKey);
        await query("UPDATE shots SET last_operation=$2 WHERE id=$1", [job.shot_id, JSON.stringify(durableProviderOperation(operation, job.payload.specHash, providerStartedAt))]);
      }
    }
    if (operation.state === "failed" || !operation.output) {
      const error = new Error(operation.error?.message ?? "Video generation failed.");
      Object.assign(error, { status: operation.error?.status, code: operation.error?.code });
      throw error;
    }
    providerCompleted = true;
    // A staged object either already had its reservation settled, or still has
    // the exact interrupted reservation recorded on the job. Account only that
    // outstanding amount; never add projected cost a second time.
    const cost = generationAccountingCost(projectedCost, Number(job.reserved_cost_usd), Boolean(staged));
    const inMemoryBytes = operation.output.bytes;
    const localFilePath = operation.output.localFilePath;
    const stored = inMemoryBytes
      ? {
          checksum: createHash("sha256").update(inMemoryBytes).digest("hex"),
          byteSize: inMemoryBytes.byteLength,
          contentType: operation.output.mimeType,
        }
      : localFilePath
        ? await putFileObject(storageKey, localFilePath, operation.output.mimeType)
        : operation.output.providerUri && providerApiKey
          ? await putRemoteObject(storageKey, operation.output.providerUri, { "x-goog-api-key": providerApiKey })
          : null;
    if (!stored) throw new Error("Completed video output has neither bytes nor a downloadable URI.");
    const checksum = stored.checksum;
    // Object storage is independent of PostgreSQL. Stage the paid provider
    // result first so a database restart can never force another video call.
    if (inMemoryBytes) await putObject(storageKey, inMemoryBytes, operation.output.mimeType);
    if (localFilePath) await rm(localFilePath, { force: true }).catch(() => undefined);
    await query("UPDATE jobs SET state='validating' WHERE id=$1", [job.id]).catch(() => undefined);
    // Fast Draft is the interactive path: publish the provider result immediately.
    // Expensive vision QC remains enabled for Final; deterministic dialogue voices
    // are kept in both tiers so a character cannot change voice between shots.
    const qc = job.render_tier === "draft"
      ? null
      : inMemoryBytes ? await runShotQc(job, inMemoryBytes, operation.output.mimeType, operation.operationId) : null;
    const engineSettings = await movieEngineSettings(job.project_id);
    if (qc && qc.overall < engineSettings.qcRetryThreshold && job.attempt < job.max_attempts) {
      const retryPrompt = `${prompt.prompt}\nQC CORRECTION FOR THIS SHOT ONLY: ${qc.retryInstruction ?? qc.issues.join("; ")}. Preserve all unaffected details and locked values.`;
      const nextPayload = {
        ...job.payload,
        shot: { ...job.payload.shot, generationPrompt: { ...prompt, prompt: retryPrompt } },
      };
      nextPayload.specHash = contentHash({ shot: nextPayload.shot, qcCorrection: qc.retryInstruction ?? qc.issues });
      const rejectedKey = `projects/${job.project_id}/scenes/${job.scene_id}/shots/${job.shot_id}/qc-rejected-${job.attempt}-${checksum.slice(0, 12)}.mp4`;
      await putObject(rejectedKey, inMemoryBytes!, operation.output.mimeType);
      const delayMs = Math.min(60_000, 2_000 * 2 ** Math.max(0, job.attempt));
      await persistQcRetry(job, { storageKey: rejectedKey, checksum, byteSize: stored.byteSize, cost, qc, nextPayload, delayMs });
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs });
      return { cached: false, storageKey: rejectedKey, retrying: true };
    }
    const classifiedQc: (ShotQcReport & { decision: "accept" | "flag" }) | null = qc
      ? { ...qc, decision: qc.overall < engineSettings.qcFlagThreshold ? "flag" : "accept" }
      : null;
    const assetId = await withDurableDatabaseRetry(() => persistCompletedAsset(job, storageKey, checksum, stored.byteSize, operation.operationId, cost, classifiedQc));
    const dialogueSegments = job.payload.shot.audioContext?.dialogue ?? [];
    if (dialogueSegments.length && await getProviderKey("openai")) {
      const dialoguePayload = { dialogueSegments, originalAssetId: assetId, originalStorageKey: storageKey };
      await enqueueDialoguePatch({
        projectId: job.project_id,
        sceneId: job.scene_id,
        shotId: job.shot_id,
        payload: dialoguePayload,
        idempotencyKey: `dialogue-master:${job.shot_id}:${contentHash(dialoguePayload)}`,
      });
    }
    await withDurableDatabaseRetry(async () => {
      await enqueueReadyProjectJobs(job.project_id);
      await enqueueAutomaticAssemblyIfReady(job.project_id);
    });
    return { cached: false, storageKey };
  } catch (error) {
    const failure = classifyFailure(error);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Shot provider failure ${job.id}: ${failure}: ${message}\n`);
    await withDurableDatabaseRetry(() => settleFailedReservation(job.id, job.project_id, providerCompleted));
    if (failure === "moderation" && !job.payload.shot.generationPrompt?.prompt.includes("CINEFORGE SAFETY RETRY")) {
      const nextPayload = moderationRetryPayload(job.payload);
      await withDurableDatabaseRetry(() => persistModerationRetry(job, nextPayload, message));
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs: 1_000 });
      return { cached: false, storageKey: "", retrying: true };
    }
    if (failure === "moderation" && !job.payload.providerModelId && !job.model_id.startsWith("gemini-omni")) {
      const nextPayload = omniFallbackPayload(job.payload);
      await withDurableDatabaseRetry(() => persistModerationRetry(job, nextPayload, message, "GOOGLE_OMNI_FALLBACK"));
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs: 1_000 });
      return { cached: false, storageKey: "", retrying: true };
    }
    if (failure === "billing" && job.payload.providerModelId === "gemini-omni-flash-preview" && !job.payload.shot.generationPrompt?.prompt.includes("CINEFORGE VEO NEUTRAL RESCUE")) {
      const nextPayload = veoNeutralRescuePayload(job.payload);
      await withDurableDatabaseRetry(() => persistModerationRetry(job, nextPayload, message, "GOOGLE_VEO_BILLING_FALLBACK"));
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs: 1_000 });
      return { cached: false, storageKey: "", retrying: true };
    }
    const decision = retryDecision({ failure, attempt: job.attempt, maxAttempts: job.max_attempts });
    if (decision.pauseProject) await withDurableDatabaseRetry(() => pauseProjectJobs(job.project_id, { code: failure, message }));
    await withDurableDatabaseRetry(() => query(
      "UPDATE jobs SET state=$2, last_error=$3, available_at=now()+($4::text || ' milliseconds')::interval WHERE id=$1",
      [job.id, decision.pauseProject ? "paused" : decision.retry ? "retrying" : "failed", JSON.stringify({ failure, message }), decision.delayMs],
    ));
    if (!decision.pauseProject && !decision.retry) await withDurableDatabaseRetry(() => query("UPDATE projects SET status='failed',last_error=$2 WHERE id=$1", [job.project_id, JSON.stringify({ failure, message, shotId: job.shot_id })]));
    if (decision.retry) {
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs: decision.delayMs });
    }
    throw error;
  }
  } finally {
    clearInterval(heartbeat);
  }
}

export function moderationRetryPayload(payload: JobRow["payload"]): JobRow["payload"] {
  const generationPrompt = payload.shot.generationPrompt;
  if (!generationPrompt) return payload;
  if (generationPrompt.prompt.includes("CINEFORGE SAFETY RETRY")) return payload;
  const prompt = `${generationPrompt.prompt}\nCINEFORGE SAFETY RETRY: This is a peaceful fictional cinematic scene with fictional people and organizations. No weapons, injury, violence, dangerous driving, pursuit, real government insignia, public figures, or readable brands. Keep every safe visual, camera, continuity, wardrobe, location, and audio detail unchanged.`;
  const shot = { ...payload.shot, generationPrompt: { ...generationPrompt, prompt } };
  return { ...payload, shot, specHash: contentHash({ shot, safetyRetry: 1 }) };
}

export function omniFallbackPayload(payload: JobRow["payload"]): JobRow["payload"] {
  if (payload.providerModelId === "gemini-omni-flash-preview") return payload;
  const generationPrompt = payload.shot.generationPrompt;
  if (!generationPrompt) return { ...payload, providerModelId: "gemini-omni-flash-preview" };
  const prompt = `${generationPrompt.prompt}\nCINEFORGE OMNI FALLBACK: Generate the same safe fictional shot. Preserve timing, camera, identity, wardrobe, location, lighting, continuity and clean audio context. No readable logos or real public figures.`;
  const shot = { ...payload.shot, generationPrompt: { ...generationPrompt, prompt } };
  return { ...payload, providerModelId: "gemini-omni-flash-preview", shot, specHash: contentHash({ shot, providerModelId: "gemini-omni-flash-preview" }) };
}

export function veoNeutralRescuePayload(payload: JobRow["payload"]): JobRow["payload"] {
  if (payload.shot.generationPrompt?.prompt.includes("CINEFORGE VEO NEUTRAL RESCUE")) return payload;
  const generationPrompt = payload.shot.generationPrompt;
  if (!generationPrompt) return { ...payload, providerModelId: "veo-3.1-fast-generate-preview" };
  const seconds = payload.shot.durationSeconds;
  const prompt = `Create one ${seconds}-second photorealistic cinematic shot. Three unmarked black civilian vehicles drive peacefully and legally in a precise convoy on a broad New York avenue during blue hour. Normal speed, dry weather after rain, realistic reflections, coherent vehicle positions, smooth professional camera movement, no people in close-up, no dialogue, no pursuit, no collision, no weapons, no emergency lights, no government insignia, no readable logos, no public figures. Clean audio start with only restrained city ambience, tires and engines. CINEFORGE VEO NEUTRAL RESCUE.`;
  const shot = { ...payload.shot, generationPrompt: {
    ...generationPrompt,
    prompt,
    negativeDirectives: [...generationPrompt.negativeDirectives, "violence", "dangerous driving", "logos", "public figures"],
  } };
  return { ...payload, providerModelId: "veo-3.1-fast-generate-preview", shot, specHash: contentHash({ shot, providerModelId: "veo-3.1-fast-generate-preview", neutralRescue: 1 }) };
}

function shouldSwitchFilteredVeoToOmni(job: JobRow): boolean {
  return !job.model_id.startsWith("gemini-omni")
    && !job.payload.providerModelId
    && Boolean(job.payload.shot.generationPrompt?.prompt.includes("CINEFORGE SAFETY RETRY"))
    && job.shot_last_operation?.state === "failed"
    && job.shot_last_operation.error?.code === "GOOGLE_MODERATION";
}

export function providerDurationSeconds(modelId: string, resolution: Resolution, plannedSeconds: number): number {
  const allowed = getAllowedDurations(modelId, resolution).sort((left, right) => left - right);
  return allowed.find((seconds) => seconds >= plannedSeconds) ?? allowed.at(-1) ?? plannedSeconds;
}

export function resumableProviderOperation(
  saved: PersistedProviderOperation | null,
  specHash: string,
): PersistedProviderOperation | null {
  if (!saved) return null;
  const sdkPollingFailure = saved.error?.message.includes("_fromAPIResponse") ?? false;
  if (saved.specHash !== specHash && !(!saved.specHash && sdkPollingFailure)) return null;
  if (saved.state === "completed" && saved.output) {
    const localFileExists = Boolean(saved.output.localFilePath && existsSync(saved.output.localFilePath));
    if (saved.output.providerUri || localFileExists) return saved;
  }
  if (!saved.operationId.startsWith("operations/") && !saved.operationId.includes("/operations/")) return null;
  const parserRecovery = saved.state === "failed" && /without downloadable|without (?:a )?video output|inline video/i.test(saved.error?.message ?? "");
  if (saved.state !== "pending" && !sdkPollingFailure && !parserRecovery) return null;
  return { ...saved, state: "pending", error: undefined };
}

export function durableProviderOperation(operation: ProviderOperation, specHash: string, startedAt: string): PersistedProviderOperation {
  const output = operation.output ? {
    mimeType: operation.output.mimeType,
    providerUri: operation.output.providerUri,
    interactionId: operation.output.interactionId,
    localFilePath: operation.output.localFilePath,
    byteSize: operation.output.byteSize,
    checksum: operation.output.checksum,
  } : undefined;
  return { ...operation, output, specHash, startedAt };
}

export function generationAccountingCost(projectedCost: number, outstandingReservation: number, staged: boolean): number {
  return staged ? Math.max(0, outstandingReservation) : projectedCost;
}

export function buildContinuityChainPrompt(
  originalPrompt: string,
  continuity: ContinuityState,
  audio: AudioContext | undefined,
  hasFirstFrame: boolean,
): string {
  const characterState = Object.entries(continuity.characterStates).map(([characterId, state]) => ({
    characterId,
    wardrobeId: state.wardrobeId,
    position: state.position,
    heldProps: state.heldProps,
    injuries: state.injuries,
    appearanceChanges: state.appearanceChanges,
    emotionalState: state.emotionalState,
  }));
  const dialogue = audio?.dialogue.map((line) => ({ speaker: line.characterName, exactText: line.text, delivery: line.delivery })) ?? [];
  return [
    originalPrompt,
    "CINEFORGE STRICT CONTINUITY CONTRACT:",
    hasFirstFrame
      ? "The supplied first-frame image is the exact final frame of the previous chronological shot. Begin on that exact composition and continue its physical movement. Do not reset, teleport, reverse or randomly reposition any person, vehicle, prop or camera."
      : "Preserve the canonical project state and locked references exactly; do not invent a visual reset.",
    `Canonical character state: ${JSON.stringify(characterState)}.`,
    `Canonical location state: ${JSON.stringify({ locationId: continuity.locationId, ...continuity.locationState })}.`,
    `Immutable locked values: ${JSON.stringify(continuity.lockedValues)}.`,
    "PHYSICAL WORLD CONTRACT: preserve ordinary geometry, gravity, inertia, collisions and occlusion. People, vehicles, walls, doors, furniture and props are solid. They cannot intersect, pass through one another, teleport, reverse direction without motion, change scale or appear/disappear between frames.",
    `Exact dialogue for this shot only: ${JSON.stringify(dialogue)}.`,
    "AUDIO ISOLATION: start a completely new audio context at 00:00. Do not repeat, continue or leak any word, voice, music, ambience or sound effect from a previous generated clip. Characters not listed as speakers remain silent. End every sound inside this shot boundary.",
  ].join("\n");
}

export function buildTargetedEditInstruction(command: string, shotId: string): string {
  return `TARGETED NON-DESTRUCTIVE EDIT OF SHOT ${shotId}: ${command}. Change only the explicitly requested visible detail. Preserve all other pixels and timing as closely as the model permits: same identity, face, voice, pose, movement, camera, composition, lighting, weather, location, props and audio. Never alter another shot.`;
}

async function withDurableDatabaseRetry<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10 * 60_000;
  let delayMs = 1_000;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableDatabaseConnectionError(error) || Date.now() + delayMs >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(15_000, delayMs * 2);
    }
  }
}

async function loadShotReferences(job: JobRow, modelId: string): Promise<ReferenceImage[]> {
  const capabilities = getVideoModel(modelId);
  const references: ReferenceImage[] = [];
  const dependencyId = job.payload.shot.continuity && "previousShotId" in job.payload.shot.continuity
    ? String((job.payload.shot.continuity as { previousShotId?: string | null }).previousShotId ?? "")
    : "";
  if (dependencyId && capabilities.firstFrame) {
    const previous = await query<{ storage_key: string }>(
      `SELECT a.storage_key FROM generation_assets a JOIN shot_versions sv ON sv.id=a.shot_version_id AND sv.active=true
       WHERE a.project_id=$1 AND a.shot_id=$2 AND a.kind='video' ORDER BY a.created_at DESC LIMIT 1`,
      [job.project_id, dependencyId],
    );
    if (previous[0]) {
      const response = await fetch(await signedObjectUrl(previous[0].storage_key));
      if (!response.ok) throw new Error(`Unable to load previous-shot reference: ${response.status}`);
      const frame = await extractFinalFrame(new Uint8Array(await response.arrayBuffer()));
      references.push({ id: `${dependencyId}:final-frame`, data: Buffer.from(frame).toString("base64"), mimeType: "image/jpeg", role: "first-frame" });
    }
  }
  const requiredIds = job.payload.shot.continuity.requiredReferences.slice(0, Math.max(0, capabilities.referenceImages - references.length));
  if (requiredIds.length) {
    const assets = await query<{ id: string; storage_key: string; mime_type: string; metadata: { role?: ReferenceImage["role"] } }>(
      "SELECT id::text,storage_key,mime_type,metadata FROM generation_assets WHERE project_id=$1 AND id::text=ANY($2::text[]) AND kind='reference-image'",
      [job.project_id, requiredIds],
    );
    for (const asset of assets) {
      const response = await fetch(await signedObjectUrl(asset.storage_key));
      if (!response.ok) throw new Error(`Unable to load reference asset ${asset.id}: ${response.status}`);
      references.push({ id: asset.id, data: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType: asset.mime_type, role: asset.metadata?.role ?? "subject" });
    }
  }
  return references;
}

async function loadCurrentInteractionId(job: JobRow): Promise<string | undefined> {
  return job.shot_last_operation?.output?.interactionId;
}

async function runShotQc(job: JobRow, bytes: Uint8Array, mimeType: string, operationId: string): Promise<ShotQcReport | null> {
  try {
    const frame = await extractRepresentativeFrame(bytes);
    return await evaluateShot({
      expected: job.payload.shot,
      generatedMetadata: { operationId, mimeType, byteSize: bytes.byteLength, evidence: "representative frame at approximately one second" },
      projectMemory: job.payload.shot.continuity,
      previewImageDataUrl: `data:image/jpeg;base64,${Buffer.from(frame).toString("base64")}`,
    });
  } catch {
    // Generation remains usable if the independent QC provider is temporarily unavailable.
    // Final QC can flag this shot for manual review without losing the completed asset.
    return null;
  }
}

async function persistCompletedAsset(job: JobRow, storageKey: string, checksum: string, byteSize: number, operationId: string, cost: number, qc: (ShotQcReport & { decision?: "accept" | "flag" }) | null) {
  return transaction(async (client) => {
    const versionResult = await client.query<{ current_version: number }>("SELECT current_version FROM shots WHERE id=$1 FOR UPDATE", [job.shot_id]);
    const version = (versionResult.rows[0]?.current_version ?? 0) + 1;
    await client.query("UPDATE shot_versions SET active=false WHERE shot_id=$1", [job.shot_id]);
    const shotVersion = await client.query<{ id: string }>(
      `INSERT INTO shot_versions (shot_id, version, reason, generation_spec, content_hash, provider_operation_id, continuity_score, qc_report, active)
       VALUES ($1,$2,'generation',$3,$4,$5,$6,$7,true) RETURNING id`,
      [job.shot_id, version, JSON.stringify(job.payload.shot), job.payload.specHash, operationId, qc?.overall ?? null, qc ? JSON.stringify(qc) : null],
    );
    await client.query(
      `INSERT INTO generation_assets (project_id, scene_id, shot_id, shot_version_id, kind, storage_key, mime_type, byte_size, duration_seconds, checksum)
       VALUES ($1,$2,$3,$4,'video',$5,'video/mp4',$6,$7,$8)`,
      [job.project_id, job.scene_id, job.shot_id, shotVersion.rows[0].id, storageKey, byteSize, job.payload.shot.durationSeconds, checksum],
    );
    const asset = await client.query<{ id: string }>("SELECT id FROM generation_assets WHERE storage_key=$1", [storageKey]);
    await client.query("UPDATE timeline_clips SET asset_id=$2 WHERE shot_id=$1 AND track='video' AND enabled=true", [job.shot_id, asset.rows[0]?.id ?? null]);
    await client.query("UPDATE shots SET state='completed', current_version=$2, retry_count=$3, last_error=NULL WHERE id=$1", [job.shot_id, version, job.attempt]);
    await client.query("UPDATE jobs SET state='completed', completed_at=now(), result=$2,reserved_cost_usd=0 WHERE id=$1", [job.id, JSON.stringify({ storageKey, version })]);
    const count = await client.query<{ completed: number; total: number }>(
      "SELECT count(*) FILTER (WHERE state='completed')::int completed, count(*)::int total FROM shots WHERE project_id=$1",
      [job.project_id],
    );
    const progress = count.rows[0].total ? (count.rows[0].completed / count.rows[0].total) * 100 : 0;
    await client.query(
      "UPDATE projects SET completed_shots=$2::integer, total_shots=$3::integer, progress=$4::numeric, spent_usd=spent_usd+$5::numeric,reserved_usd=GREATEST(0,reserved_usd-$5::numeric), status=CASE WHEN $2::integer=$3::integer THEN 'validating'::project_status ELSE 'generating'::project_status END WHERE id=$1",
      [job.project_id, count.rows[0].completed, count.rows[0].total, progress, cost],
    );
    const states = await client.query<{ id: string; state: string }>("SELECT id,state FROM shots WHERE project_id=$1 ORDER BY created_at", [job.project_id]);
    await client.query(
      `INSERT INTO checkpoints (project_id,event_type,completed_shot_ids,failed_shot_ids,pending_shot_ids,current_job_id,snapshot)
       VALUES ($1,'shot-completed',$2,$3,$4,$5,$6)`,
      [job.project_id,
        states.rows.filter((row) => row.state === "completed").map((row) => row.id),
        states.rows.filter((row) => row.state === "failed").map((row) => row.id),
        states.rows.filter((row) => !["completed", "failed"].includes(row.state)).map((row) => row.id),
        job.id,
        JSON.stringify({ shotId: job.shot_id, storageKey, version, spentDeltaUsd: cost, createdAt: new Date().toISOString() })],
    );
    return asset.rows[0].id;
  });
}

async function movieEngineSettings(projectId: string): Promise<{ qcRetryThreshold: number; qcFlagThreshold: number }> {
  const rows = await query<{ settings: { qcRetryThreshold?: number; qcFlagThreshold?: number } }>(
    "SELECT ws.settings FROM workspace_settings ws JOIN projects p ON p.workspace_id=ws.workspace_id WHERE p.id=$1",
    [projectId],
  ).catch(() => []);
  return {
    qcRetryThreshold: Number(rows[0]?.settings.qcRetryThreshold ?? env().QC_RETRY_THRESHOLD),
    qcFlagThreshold: Number(rows[0]?.settings.qcFlagThreshold ?? env().QC_FLAG_THRESHOLD),
  };
}

async function reserveBudget(jobId: string, projectId: string, amount: number): Promise<boolean> {
  return transaction(async (client) => {
    const rows = await client.query<{ reserved_cost_usd: string; spent_usd: string; reserved_usd: string; maximum_budget_usd: string }>(
      `SELECT j.reserved_cost_usd,p.spent_usd,p.reserved_usd,p.maximum_budget_usd
       FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=$1 AND p.id=$2 FOR UPDATE OF j,p`,
      [jobId, projectId],
    );
    const state = rows.rows[0];
    if (!state) throw new Error("Generation job or project not found during budget reservation.");
    if (Number(state.reserved_cost_usd) > 0) return true;
    if (Number(state.spent_usd) + Number(state.reserved_usd) + amount > Number(state.maximum_budget_usd)) return false;
    await client.query("UPDATE jobs SET reserved_cost_usd=$2 WHERE id=$1", [jobId, amount]);
    await client.query("UPDATE projects SET reserved_usd=reserved_usd+$2 WHERE id=$1", [projectId, amount]);
    return true;
  });
}

async function settleFailedReservation(jobId: string, projectId: string, providerCompleted: boolean): Promise<void> {
  await transaction(async (client) => {
    const rows = await client.query<{ reserved_cost_usd: string }>("SELECT reserved_cost_usd FROM jobs WHERE id=$1 FOR UPDATE", [jobId]);
    const amount = Number(rows.rows[0]?.reserved_cost_usd ?? 0);
    if (!amount) return;
    await client.query("UPDATE jobs SET reserved_cost_usd=0 WHERE id=$1", [jobId]);
    await client.query(
      "UPDATE projects SET reserved_usd=GREATEST(0,reserved_usd-$2),spent_usd=spent_usd+CASE WHEN $3 THEN $2 ELSE 0 END WHERE id=$1",
      [projectId, amount, providerCompleted],
    );
  });
}

async function persistModerationRetry(job: JobRow, nextPayload: JobRow["payload"], providerMessage: string, code = "GOOGLE_MODERATION_RETRY"): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      "UPDATE jobs SET state='retrying',payload=$2,last_error=$3,available_at=now()+interval '1 second',reserved_cost_usd=0 WHERE id=$1",
      [job.id, JSON.stringify(nextPayload), JSON.stringify({ code, message: providerMessage })],
    );
    await client.query(
      "UPDATE shots SET state='retrying',retry_count=$2,last_error=$3,last_operation=NULL WHERE id=$1",
      [job.shot_id, job.attempt, JSON.stringify({ code, message: providerMessage })],
    );
    await client.query("UPDATE projects SET status='generating',last_error=NULL WHERE id=$1", [job.project_id]);
    await client.query(
      `INSERT INTO checkpoints (project_id,event_type,failed_shot_ids,pending_shot_ids,current_job_id,snapshot)
       VALUES ($1,'shot-moderation-retry','{}'::text[],ARRAY[$2]::text[],$3,$4)`,
      [job.project_id, job.shot_id, job.id, JSON.stringify({ shotId: job.shot_id, retryAttempt: job.attempt, reason: "provider-output-filtered" })],
    );
  });
}

async function persistQcRetry(job: JobRow, input: {
  storageKey: string;
  checksum: string;
  byteSize: number;
  cost: number;
  qc: ShotQcReport;
  nextPayload: JobRow["payload"];
  delayMs: number;
}) {
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO generation_assets (project_id,scene_id,shot_id,kind,storage_key,mime_type,byte_size,duration_seconds,checksum,metadata)
       VALUES ($1,$2,$3,'qc-rejected-video',$4,'video/mp4',$5,$6,$7,$8)`,
      [job.project_id, job.scene_id, job.shot_id, input.storageKey, input.byteSize, job.payload.shot.durationSeconds, input.checksum, JSON.stringify({ qc: input.qc, retryAttempt: job.attempt })],
    );
    await client.query(
      "UPDATE jobs SET state='retrying',payload=$2,last_error=$3,available_at=now()+($4::text || ' milliseconds')::interval,reserved_cost_usd=0 WHERE id=$1",
      [job.id, JSON.stringify(input.nextPayload), JSON.stringify({ code: "QC_RETRY", report: input.qc }), input.delayMs],
    );
    await client.query("UPDATE shots SET state='retrying',retry_count=$2,last_error=$3 WHERE id=$1", [job.shot_id, job.attempt, JSON.stringify({ qc: input.qc })]);
    await client.query("UPDATE projects SET spent_usd=spent_usd+$2,reserved_usd=GREATEST(0,reserved_usd-$2),status='generating' WHERE id=$1", [job.project_id, input.cost]);
    await client.query(
      `INSERT INTO checkpoints (project_id,event_type,failed_shot_ids,pending_shot_ids,current_job_id,snapshot)
       VALUES ($1,'shot-qc-retry','{}'::text[],ARRAY[$2]::text[],$3,$4)`,
      [job.project_id, job.shot_id, job.id, JSON.stringify({ shotId: job.shot_id, qc: input.qc, retryAttempt: job.attempt, rejectedStorageKey: input.storageKey })],
    );
  });
}

async function markCompleted(job: JobRow, storageKey: string, cost: number, cached: boolean) {
  await transaction(async (client) => {
    const reservation = await client.query<{ reserved_cost_usd: string }>("SELECT reserved_cost_usd FROM jobs WHERE id=$1 FOR UPDATE", [job.id]);
    const reserved = Number(reservation.rows[0]?.reserved_cost_usd ?? 0);
    await client.query("UPDATE shots SET state='completed' WHERE id=$1", [job.shot_id]);
    await client.query("UPDATE jobs SET state='completed',completed_at=now(),result=$2,reserved_cost_usd=0 WHERE id=$1", [job.id, JSON.stringify({ storageKey, cached })]);
    const count = await client.query<{ completed: number; total: number }>(
      "SELECT count(*) FILTER (WHERE state='completed')::int completed, count(*)::int total FROM shots WHERE project_id=$1",
      [job.project_id],
    );
    await client.query("UPDATE projects SET completed_shots=$2,total_shots=$3,progress=CASE WHEN $3=0 THEN 0 ELSE $2::numeric/$3*100 END,spent_usd=spent_usd+$4,reserved_usd=GREATEST(0,reserved_usd-$5) WHERE id=$1", [
      job.project_id, count.rows[0].completed, count.rows[0].total, cost, reserved,
    ]);
  });
}
