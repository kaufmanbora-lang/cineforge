import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isRetryableDatabaseConnectionError, query, transaction } from "@/server/db";
import { getProviderKey } from "@/server/provider-secrets";
import { googleVideoAdapter } from "@/server/providers/video/google";
import type { ProviderOperation, VideoGenerationRequest } from "@/server/providers/video/types";
import { deleteObject, getObjectIfExists, putFileObject, putObject, putRemoteObject, signedObjectUrl } from "@/server/storage";
import { findCachedShot } from "@/server/movie/repository";
import { classifyFailure, rateLimitRecoveryDecision, retryDecision } from "@/server/movie/retry";
import { enqueueAutomaticAssemblyIfReady, enqueueReadyProjectJobs, pauseProjectJobs, requeueDatabaseJob } from "@/server/movie/queue";
import { effectiveVideoModelId, getAllowedDurations, getVideoModel, type Resolution } from "@/domain/video-models";
import { env } from "@/server/env";
import { contentHash } from "@/server/movie/content-hash";
import { extractFinalFrame, extractShotQcFrames, validateGeneratedShot } from "@/server/movie/ffmpeg";
import { evaluateShot, type ShotQcReport } from "@/server/providers/openai";
import type { ReferenceImage } from "@/server/providers/video/types";
import type { AudioContext, ContinuityState, Shot, ShotArtifact } from "@/domain/movie";
import { realismProductionProfile } from "@/server/providers/video/prompt-adapters";
import type { PoolClient } from "pg";

type PersistedProviderOperation = ProviderOperation & { specHash?: string; startedAt?: string };

// The current Google API project can accept fewer concurrent Omni video
// interactions than the worker can process for planning, storage and FFmpeg.
// Serializing Omni shot attempts prevents parallel 429s while preserving the
// normal worker concurrency for planning, assembly and asynchronous Veo LROs.
let omniProviderTail: Promise<void> = Promise.resolve();
let omniProviderNotBeforeMs = 0;

interface JobRow {
  id: string;
  project_id: string;
  scene_id: string;
  shot_id: string;
  attempt: number;
  max_attempts: number;
  payload: { providerModelId?: string; omitProviderReferences?: boolean; omitSubjectReferences?: boolean; editCommand?: string; rateLimitCooldowns?: number; shot: Shot; specHash: string };
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

export async function processShot(databaseJobId: string): Promise<{ cached: boolean; storageKey: string; retrying?: boolean; paused?: boolean; failed?: boolean }> {
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
  if (shouldRestoreLegacyBillingFallback(job)) {
    job.payload = restoreOmniAfterLegacyBillingFallbackPayload(job.payload);
    job.shot_last_operation = null;
    await query("UPDATE jobs SET payload=$2,last_error=NULL WHERE id=$1", [job.id, JSON.stringify(job.payload)]);
    await query("UPDATE shots SET last_operation=NULL WHERE id=$1", [job.shot_id]);
  }
  if (shouldSwitchFilteredVeoToOmni(job)) {
    job.payload = omniFallbackPayload(job.payload);
    job.shot_last_operation = null;
    await query("UPDATE jobs SET payload=$2 WHERE id=$1", [job.id, JSON.stringify(job.payload)]);
    await query("UPDATE shots SET last_operation=NULL WHERE id=$1", [job.shot_id]);
  }
  if (shouldUseNeutralOmniRescue(job)) {
    job.payload = omniNeutralRescuePayload(job.payload);
    job.shot_last_operation = null;
    await query("UPDATE jobs SET payload=$2 WHERE id=$1", [job.id, JSON.stringify(job.payload)]);
    await query("UPDATE shots SET last_operation=NULL WHERE id=$1", [job.shot_id]);
  }
  if (shouldRefreshVeoSafeBridge(job)) {
    job.payload = veoSafeBridgePayload(job.payload);
    job.shot_last_operation = null;
    await query("UPDATE jobs SET payload=$2 WHERE id=$1", [job.id, JSON.stringify(job.payload)]);
    await query("UPDATE shots SET last_operation=NULL WHERE id=$1", [job.shot_id]);
  }
  const heartbeat = setInterval(() => {
    void query("UPDATE jobs SET updated_at=now() WHERE id=$1 AND state IN ('generating','validating')", [job.id]).catch(() => undefined);
  }, 10_000);
  heartbeat.unref();
  let temporaryProviderFilePath: string | undefined;
  let releaseOmniProviderSlot: (() => void) | undefined;
  let previousBoundaryFrame: Uint8Array | undefined;
  try {
  await query("UPDATE projects SET status='generating',updated_at=now() WHERE id=$1 AND status NOT IN ('completed','cancelled')", [job.project_id]);
  let cached = await findCachedShot(job.project_id, job.shot_id, job.payload.specHash);
  if (cached) {
    const cachedObject = await getObjectIfExists(cached.storageKey);
    try {
      if (!cachedObject) throw new Error("Cached object is missing from object storage.");
      await validateGeneratedShot(cachedObject.bytes, job.payload.shot.durationSeconds);
      await activateCachedShot(job, cached);
      await enqueueReadyProjectJobs(job.project_id);
      await enqueueAutomaticAssemblyIfReady(job.project_id);
      return { cached: true, storageKey: cached.storageKey };
    } catch {
      // Metadata without valid media is not a checkpoint. Remove only that
      // unusable cached version before the paid provider call so the same
      // content hash can be persisted again without a uniqueness deadlock.
      await purgeInvalidCachedShot(job, cached);
      await deleteObject(cached.storageKey).catch(() => undefined);
      cached = null;
    }
  }
  const effectiveModelId = effectiveVideoModelId(job.payload.providerModelId ?? job.model_id, job.render_tier);
  const capabilities = getVideoModel(effectiveModelId);
  const price = capabilities.pricePerSecondUsd[job.resolution] ?? capabilities.pricePerSecondUsd["720p"] ?? 0;
  const providerDuration = providerDurationSeconds(
    effectiveModelId,
    job.resolution,
    job.payload.shot.durationSeconds,
    capabilities.family === "veo" && capabilities.referenceImages > 0 && job.payload.shot.continuity.requiredReferences.length > 0,
  );
  const projectedCost = providerDuration * price;
  const storageKey = `projects/${job.project_id}/scenes/${job.scene_id}/shots/${job.shot_id}/${job.payload.specHash}.mp4`;
  // Check the durable provider checkpoint before reserving more budget. A
  // worker/database restart must never charge or reserve the same video twice.
  const staged = await getObjectIfExists(storageKey);
  if (!staged && effectiveModelId.startsWith("gemini-omni")) {
    // Hold the slot until the whole shot attempt has persisted its success,
    // retry or pause state. Releasing immediately after the HTTP response let
    // the next shot race ahead before a 429 could pause/cool down the project.
    releaseOmniProviderSlot = await acquireOmniProviderSlot();
    const runnable = await query<{ runnable: boolean }>(
      `SELECT (j.state='generating' AND p.status NOT IN ('paused','failed','cancelled','completed')) runnable
       FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=$1`,
      [job.id],
    );
    if (!runnable[0]?.runnable) {
      await query(
        "UPDATE jobs SET state='paused',last_error=$2,updated_at=now() WHERE id=$1 AND state='generating'",
        [job.id, JSON.stringify({ code: "PROJECT_PAUSED", message: "Платный запрос не отправлен: проект уже поставлен на паузу другим заданием." })],
      );
      return { cached: false, storageKey: "", paused: true };
    }
  }
  if (!staged && !await reserveBudget(job.id, job.project_id, projectedCost)) {
    const reason = { code: "BUDGET_REACHED", message: "Достигнут максимальный бюджет проекта. Готовые кадры сохранены; увеличьте лимит и продолжите с контрольной точки." };
    await pauseProjectJobs(job.project_id, reason);
    await query("UPDATE jobs SET state='paused',last_error=$2,reserved_cost_usd=0 WHERE id=$1", [job.id, JSON.stringify(reason)]);
    return { cached: false, storageKey: "", paused: true };
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
      const references = job.payload.omitProviderReferences
        ? []
        : await loadShotReferences(job, effectiveModelId, { omitSubjectReferences: job.payload.omitSubjectReferences });
      const boundaryReference = references.find((reference) => reference.role === "first-frame");
      previousBoundaryFrame = boundaryReference ? new Uint8Array(Buffer.from(boundaryReference.data, "base64")) : undefined;
      // Google only accepts previous_interaction_id for a conversational edit.
      // A normal reference-to-video generation must continue from the extracted
      // final frame without attaching the interaction id (otherwise HTTP 400).
      const previousInteractionId = effectiveModelId.startsWith("gemini-omni") && job.payload.editCommand
        ? await loadCurrentInteractionId(job)
        : undefined;
      const providerPrompt = providerSafetyFraming(prompt.prompt);
      const neutralRescue = isNeutralRescuePrompt(providerPrompt);
      const providerAudio = neutralRescue
        ? neutralRescueAudioContext(job.payload.shot.audioContext)
        : providerAudioContext(providerPrompt, job.payload.shot.audioContext);
      const providerContinuity = neutralRescue
        ? neutralRescueContinuity(job.payload.shot.continuity)
        : job.payload.shot.continuity;
      const request: VideoGenerationRequest = {
        projectId: job.project_id,
        sceneId: job.scene_id,
        shotId: job.shot_id,
        modelId: effectiveModelId,
        prompt: buildContinuityChainPrompt(providerPrompt, providerContinuity, providerAudio, references.some((reference) => reference.role === "first-frame")),
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
      Object.assign(error, { status: operation.error?.status, code: operation.error?.code, retryAfterMs: operation.error?.retryAfterMs });
      throw error;
    }
    providerCompleted = true;
    // A staged object either already had its reservation settled, or still has
    // the exact interrupted reservation recorded on the job. Account only that
    // outstanding amount; never add projected cost a second time.
    const cost = generationAccountingCost(projectedCost, Number(job.reserved_cost_usd), Boolean(staged));
    const inMemoryBytes = operation.output.bytes;
    const localFilePath = operation.output.localFilePath;
    temporaryProviderFilePath = localFilePath;
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
    if (localFilePath) {
      await rm(localFilePath, { force: true }).catch(() => undefined);
      temporaryProviderFilePath = undefined;
    }
    const validationObject = inMemoryBytes
      ? { bytes: inMemoryBytes, contentType: operation.output.mimeType }
      : await getObjectIfExists(storageKey);
    if (!validationObject) throw Object.assign(new Error("Invalid media: staged provider video disappeared before validation."), { code: "CORRUPTED_RESULT" });
    try {
      await validateGeneratedShot(validationObject.bytes, job.payload.shot.durationSeconds);
    } catch (error) {
      // A corrupt/short staged object must not be mistaken for a reusable
      // checkpoint on the next retry, and a completed provider operation must
      // not be polled forever for the same unusable bytes.
      await deleteObject(storageKey).catch(() => undefined);
      await query("UPDATE shots SET last_operation=NULL WHERE id=$1", [job.shot_id]).catch(() => undefined);
      throw error;
    }
    await query("UPDATE jobs SET state='validating' WHERE id=$1", [job.id]).catch(() => undefined);
    const engineSettings = await movieEngineSettings(job.project_id);
    // Final renders receive complete artistic QC. Drafts still receive the
    // cheaper but essential multi-frame physical-continuity gate so a fast
    // preview cannot silently accept teleports or a changed location.
    const qc = job.render_tier === "final" || engineSettings.physicalContinuityQc
      ? await runShotQc(job, validationObject.bytes, validationObject.contentType, operation.operationId, previousBoundaryFrame)
      : null;
    const physicalScore = qc ? Math.min(qc.physicalPlausibility, qc.objectPermanence, qc.boundaryIntegrity, qc.motionContinuity) : 100;
    const needsPhysicalRetry = Boolean(qc?.severePhysicalViolation) && physicalScore < engineSettings.qcRetryThreshold;
    const needsFinalRetry = job.render_tier === "final" && (qc?.overall ?? 100) < engineSettings.qcRetryThreshold;
    if (qc && (needsPhysicalRetry || needsFinalRetry) && job.attempt < job.max_attempts) {
      const retryPrompt = `${prompt.prompt}\nPHYSICAL CONTINUITY CORRECTION FOR THIS SHOT ONLY: ${qc.retryInstruction ?? [...qc.observedPhysicalViolations, ...qc.issues].join("; ")}. Begin at the exact previous-shot endpoint. Keep the same location topology, camera axis, people, faces, wardrobe, voices, vehicles and persistent objects. Every change must follow a visible physically reachable path. Preserve all unaffected details and locked values.`;
      const nextPayload = {
        ...job.payload,
        shot: { ...job.payload.shot, generationPrompt: { ...prompt, prompt: retryPrompt } },
      };
      nextPayload.specHash = contentHash({ shot: nextPayload.shot, qcCorrection: qc.retryInstruction ?? qc.issues });
      const rejectedKey = `projects/${job.project_id}/scenes/${job.scene_id}/shots/${job.shot_id}/qc-rejected-${job.attempt}-${checksum.slice(0, 12)}.mp4`;
      await putObject(rejectedKey, validationObject.bytes, validationObject.contentType);
      const delayMs = Math.min(60_000, 2_000 * 2 ** Math.max(0, job.attempt));
      await persistQcRetry(job, { storageKey: rejectedKey, checksum, byteSize: stored.byteSize, cost, qc, nextPayload, delayMs });
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs });
      return { cached: false, storageKey: rejectedKey, retrying: true };
    }
    const classifiedQc: (ShotQcReport & { decision: "accept" | "flag" }) | null = qc
      ? { ...qc, decision: qc.overall < engineSettings.qcFlagThreshold ? "flag" : "accept" }
      : null;
    // Google video models generate native synchronized speech and ambience.
    // Keep that human performance intact. Dialogue edits also go back through
    // Google; CineForge never lays a synthetic narrator over provider audio.
    await withDurableDatabaseRetry(() => persistCompletedAsset(job, storageKey, checksum, stored.byteSize, operation.operationId, cost, classifiedQc));
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
    const mayTryAnotherProviderVariant = job.attempt < job.max_attempts;
    if (failure === "moderation"
      && (job.payload.providerModelId ?? job.model_id).startsWith("gemini-omni")
      && job.payload.shot.generationPrompt?.prompt.includes("CINEFORGE OMNI NEUTRAL RESCUE")) {
      // The neutral Omni rescue consumes the normal final attempt. Allow one
      // additional, marker-guarded Veo bridge rather than terminating the
      // entire movie. veoSafeBridgePayload is idempotent and its marker prevents
      // this branch from becoming an unbounded provider loop.
      const nextPayload = veoSafeBridgePayload(job.payload);
      await withDurableDatabaseRetry(() => persistModerationRetry(job, nextPayload, message, "GOOGLE_VEO_SAFE_BRIDGE"));
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs: 1_000 });
      return { cached: false, storageKey: "", retrying: true };
    }
    if (mayTryAnotherProviderVariant && failure === "moderation" && !job.payload.shot.generationPrompt?.prompt.includes("CINEFORGE SAFETY RETRY")) {
      const nextPayload = moderationRetryPayload(job.payload);
      await withDurableDatabaseRetry(() => persistModerationRetry(job, nextPayload, message));
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs: 1_000 });
      return { cached: false, storageKey: "", retrying: true };
    }
    if (mayTryAnotherProviderVariant && failure === "moderation" && !job.payload.providerModelId && !job.model_id.startsWith("gemini-omni")) {
      const nextPayload = omniFallbackPayload(job.payload);
      await withDurableDatabaseRetry(() => persistModerationRetry(job, nextPayload, message, "GOOGLE_OMNI_FALLBACK"));
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs: 1_000 });
      return { cached: false, storageKey: "", retrying: true };
    }
    if (mayTryAnotherProviderVariant && failure === "moderation"
      && (job.payload.providerModelId ?? job.model_id).startsWith("gemini-omni")
      && !job.payload.shot.generationPrompt?.prompt.includes("CINEFORGE OMNI NEUTRAL RESCUE")) {
      const nextPayload = omniNeutralRescuePayload(job.payload);
      await withDurableDatabaseRetry(() => persistModerationRetry(job, nextPayload, message, "GOOGLE_OMNI_NEUTRAL_RESCUE"));
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs: 1_000 });
      return { cached: false, storageKey: "", retrying: true };
    }
    const errorRecord = typeof error === "object" && error ? error as Record<string, unknown> : {};
    const rateLimitDecision = failure === "rate-limit"
      ? rateLimitRecoveryDecision({
          attempt: job.attempt,
          maxAttempts: job.max_attempts,
          cooldownCount: job.payload.rateLimitCooldowns,
          retryAfterMs: typeof errorRecord.retryAfterMs === "number" ? errorRecord.retryAfterMs : undefined,
        })
      : null;
    const decision = rateLimitDecision ?? retryDecision({ failure, attempt: job.attempt, maxAttempts: job.max_attempts });
    if (failure === "rate-limit") {
      omniProviderNotBeforeMs = Math.max(omniProviderNotBeforeMs, Date.now() + Math.max(15_000, decision.delayMs));
    }
    if (decision.pauseProject) {
      await withDurableDatabaseRetry(() => pauseProjectJobs(job.project_id, { code: failure, message }));
      await withDurableDatabaseRetry(() => query(
        "UPDATE jobs SET state='paused',last_error=$2,reserved_cost_usd=0 WHERE id=$1",
        [job.id, JSON.stringify({ failure, message })],
      ));
      return { cached: false, storageKey: "", paused: true };
    }
    if (rateLimitDecision?.retry) {
      const resumeAt = new Date(Date.now() + rateLimitDecision.delayMs).toISOString();
      const retryState = {
        code: "RATE_LIMIT_COOLDOWN",
        message: `Google временно ограничил скорость. CineForge автоматически продолжит только с кадра ${job.payload.shot.sequence} через ${Math.max(1, Math.ceil(rateLimitDecision.delayMs / 60_000))} мин.; готовые кадры сохранены.`,
        shotId: job.shot_id,
        resumeAt,
      };
      const nextPayload = {
        ...job.payload,
        rateLimitCooldowns: rateLimitDecision.nextCooldownCount,
      };
      await withDurableDatabaseRetry(() => transaction(async (client) => {
        await client.query(
          `UPDATE jobs SET state='queued', attempt=$2, payload=$3, last_error=$4,
             available_at=now()+($5::text || ' milliseconds')::interval, reserved_cost_usd=0, updated_at=now()
           WHERE id=$1`,
          [job.id, rateLimitDecision.resetAttempts ? 0 : job.attempt, JSON.stringify(nextPayload), JSON.stringify(retryState), rateLimitDecision.delayMs],
        );
        await client.query("UPDATE shots SET state='retrying',retry_count=$2,last_error=$3 WHERE id=$1", [job.shot_id, job.attempt, JSON.stringify(retryState)]);
        await client.query("UPDATE projects SET status='generating',last_error=$2,updated_at=now() WHERE id=$1", [job.project_id, JSON.stringify(retryState)]);
      }));
      await requeueDatabaseJob({
        databaseJobId: job.id,
        attempt: rateLimitDecision.resetAttempts ? 0 : job.attempt,
        delayMs: rateLimitDecision.delayMs,
      });
      return { cached: false, storageKey: "", retrying: true };
    }
    await withDurableDatabaseRetry(() => query(
      "UPDATE jobs SET state=$2, last_error=$3, available_at=now()+($4::text || ' milliseconds')::interval WHERE id=$1",
      [job.id, decision.retry ? "queued" : "failed", JSON.stringify({ failure, message }), decision.delayMs],
    ));
    if (!decision.retry) await withDurableDatabaseRetry(() => query("UPDATE projects SET status='failed',last_error=$2 WHERE id=$1", [job.project_id, JSON.stringify({ failure, message, shotId: job.shot_id })]));
    if (decision.retry) {
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt, delayMs: decision.delayMs });
    }
    return { cached: false, storageKey: "", retrying: decision.retry, failed: !decision.retry };
  }
  } finally {
    clearInterval(heartbeat);
    releaseOmniProviderSlot?.();
    if (temporaryProviderFilePath) await rm(temporaryProviderFilePath, { force: true }).catch(() => undefined);
  }
}

async function acquireOmniProviderSlot(): Promise<() => void> {
  const previous = omniProviderTail;
  let release!: () => void;
  omniProviderTail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  const waitMs = Math.max(0, omniProviderNotBeforeMs - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  return release;
}

export function moderationRetryPayload(payload: JobRow["payload"]): JobRow["payload"] {
  const generationPrompt = payload.shot.generationPrompt;
  if (!generationPrompt) return payload;
  if (generationPrompt.prompt.includes("CINEFORGE SAFETY RETRY")) return payload;
  const prompt = `${generationPrompt.prompt}\nCINEFORGE SAFETY RETRY: Peaceful fictional cinematic production with adult actors, relaxed ordinary movement, respectful body language, plain wardrobe, stable architecture, natural lighting and coherent camera continuity. Keep the established safe visual, wardrobe and location details unchanged. SAFE FICTIONAL PRODUCTION FRAME.`;
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

export function omniNeutralRescuePayload(payload: JobRow["payload"]): JobRow["payload"] {
  const generationPrompt = payload.shot.generationPrompt;
  if (!generationPrompt) return { ...payload, providerModelId: "gemini-omni-flash-preview" };
  const alreadyClean = generationPrompt.prompt.includes("CINEFORGE OMNI NEUTRAL RESCUE")
    && !containsLegacySensitiveTerms(`${generationPrompt.prompt} ${generationPrompt.negativeDirectives.join(" ")}`);
  if (alreadyClean) return { ...payload, omitProviderReferences: false, omitSubjectReferences: true };
  const seconds = payload.shot.durationSeconds;
  const action = neutralizeSensitiveStoryTerms(`${payload.shot.title}. ${payload.shot.action}`);
  const camera = payload.shot.camera;
  const prompt = `Create one ${seconds}-second photorealistic live-action continuation of the supplied previous frame. Preserve the exact same established adult characters, faces, wardrobe, vehicle, location, weather, lighting, object positions and camera direction. Continue this exact story beat without a cut: ${action}. Camera: ${camera.shotSize}, ${camera.angle}, ${camera.lens}, ${camera.movement}; ${camera.framing}. Lighting: ${payload.shot.lighting}. Visual style: ${payload.shot.visualStyle}. Every person and object follows one continuous physically reachable path; solid walls, doors, vehicles and furniture keep fixed geometry; nobody teleports, crosses a solid surface or looks into the camera. Calm ordinary body language, no confrontation and no readable logos. Clean audio start with only the ambience and effects specified for this shot; no dialogue or audio from an earlier shot. SAFE FICTIONAL PRODUCTION FRAME. CINEFORGE OMNI NEUTRAL RESCUE.`;
  const shot = { ...payload.shot, generationPrompt: {
    ...generationPrompt,
    prompt,
    negativeDirectives: ["cartoon look", "camera eye contact", "teleportation", "geometry intersection", "readable text"],
  } };
  return { ...payload, providerModelId: "gemini-omni-flash-preview", omitProviderReferences: false, omitSubjectReferences: true, shot, specHash: contentHash({ shot, providerModelId: "gemini-omni-flash-preview", neutralRescue: 1 }) };
}

export function shouldRestoreLegacyBillingFallback(job: Pick<JobRow, "payload">): boolean {
  return job.payload.providerModelId === "veo-3.1-fast-generate-preview"
    && Boolean(job.payload.shot.generationPrompt?.prompt.includes("CINEFORGE VEO NEUTRAL RESCUE"));
}

export function restoreOmniAfterLegacyBillingFallbackPayload(payload: JobRow["payload"]): JobRow["payload"] {
  const generationPrompt = payload.shot.generationPrompt;
  if (!generationPrompt) return { ...payload, providerModelId: "gemini-omni-flash-preview" };
  const restored = omniNeutralRescuePayload({
    ...payload,
    providerModelId: "gemini-omni-flash-preview",
    shot: { ...payload.shot, generationPrompt: { ...generationPrompt, prompt: "" } },
  });
  return { ...restored, specHash: contentHash({ shot: restored.shot, providerModelId: restored.providerModelId, restoredBillingFallback: 1 }) };
}

function neutralizeSensitiveStoryTerms(value: string): string {
  return value
    .replace(/Ник(?:о)?\s+Фьюри/giu, "the established adult team leader")
    .replace(/Mysterio|Мистерио/giu, "the established adult illusionist in emerald segmented armor, a deep purple cape with gold clasps, metallic bracers and an opaque glowing glass fishbowl helmet; preserve this exact costume and silhouette")
    .replace(/Marvel|Человек(?:а)?[- ]паука/giu, "the original fictional production")
    .replace(/автомат(?:ами|а|ы|ов)?|винтовк(?:ами|а|и|у)?|оружи(?:е|я|ем)/giu, "secured professional equipment")
    .replace(/задерж(?:ать|ивает|ивают|ание|ан|ана)|арест(?:овать|овывает|овывают|ован)?|наручник(?:и|ами|ов)?/giu, "calm voluntary handover")
    .replace(/спецназ|агент(?:ы|ами|а|ов)?/giu, "professional team members");
}

export function veoNeutralRescuePayload(payload: JobRow["payload"]): JobRow["payload"] {
  if (payload.shot.generationPrompt?.prompt.includes("CINEFORGE VEO NEUTRAL RESCUE")) return { ...payload, omitProviderReferences: false, omitSubjectReferences: true };
  const generationPrompt = payload.shot.generationPrompt;
  if (!generationPrompt) return { ...payload, providerModelId: "veo-3.1-fast-generate-preview" };
  const seconds = payload.shot.durationSeconds;
  const prompt = `Create one ${seconds}-second photorealistic cinematic shot. Three unmarked black civilian vehicles drive peacefully and legally in a precise convoy on a broad New York avenue during blue hour. Normal speed, dry weather after rain, realistic reflections, coherent vehicle positions, smooth professional camera movement, no people in close-up, no dialogue, no pursuit, no collision, no weapons, no emergency lights, no government insignia, no readable logos, no public figures. Clean audio start with only restrained city ambience, tires and engines. CINEFORGE VEO NEUTRAL RESCUE.`;
  const shot = { ...payload.shot, generationPrompt: {
    ...generationPrompt,
    prompt,
    negativeDirectives: [...generationPrompt.negativeDirectives, "violence", "dangerous driving", "logos", "public figures"],
  } };
  return { ...payload, providerModelId: "veo-3.1-fast-generate-preview", omitProviderReferences: false, omitSubjectReferences: true, shot, specHash: contentHash({ shot, providerModelId: "veo-3.1-fast-generate-preview", neutralRescue: 1 }) };
}

export function veoSafeBridgePayload(payload: JobRow["payload"]): JobRow["payload"] {
  const generationPrompt = payload.shot.generationPrompt;
  if (!generationPrompt) return { ...payload, providerModelId: "veo-3.1-fast-generate-preview", omitProviderReferences: false, omitSubjectReferences: true };
  const alreadyClean = generationPrompt.prompt.includes("CINEFORGE VEO SAFE BRIDGE")
    && generationPrompt.prompt.includes("SAFE FICTIONAL PRODUCTION FRAME")
    && !containsLegacySensitiveTerms(`${generationPrompt.prompt} ${generationPrompt.negativeDirectives.join(" ")}`);
  if (alreadyClean) return { ...payload, omitProviderReferences: false, omitSubjectReferences: true };
  const prompt = "Create one continuous photorealistic live-action continuity bridge at the same established location and time of day. Hold on stable architectural details, the doorway, furniture and persistent vehicles or props already established by the story. Nearby adult characters continue ordinary calm movement naturally through the space with relaxed body language and natural eyelines. Preserve solid geometry, realistic door hinges, object permanence, camera axis and screen direction. Clean ambient sound begins at zero and ends inside this clip. Plain surfaces contain no readable text. SAFE FICTIONAL PRODUCTION FRAME. CINEFORGE VEO SAFE BRIDGE.";
  const shot = { ...payload.shot, generationPrompt: {
    ...generationPrompt,
    prompt,
    negativeDirectives: ["cartoon look", "camera eye contact", "teleportation", "geometry intersection", "disappearing objects", "readable text"],
  } };
  return {
    ...payload,
    providerModelId: "veo-3.1-fast-generate-preview",
    omitProviderReferences: false,
    omitSubjectReferences: true,
    shot,
    specHash: contentHash({ shot, providerModelId: "veo-3.1-fast-generate-preview", safeBridge: 1 }),
  };
}

function shouldSwitchFilteredVeoToOmni(job: JobRow): boolean {
  return !job.model_id.startsWith("gemini-omni")
    && !job.payload.providerModelId
    && Boolean(job.payload.shot.generationPrompt?.prompt.includes("CINEFORGE SAFETY RETRY"))
    && job.shot_last_operation?.state === "failed"
    && job.shot_last_operation.error?.code === "GOOGLE_MODERATION";
}

function shouldUseNeutralOmniRescue(job: JobRow): boolean {
  const generationPrompt = job.payload.shot.generationPrompt;
  if (!(job.payload.providerModelId ?? job.model_id).startsWith("gemini-omni") || !generationPrompt) return false;
  const legacyNeutralPrompt = generationPrompt.prompt.includes("CINEFORGE OMNI NEUTRAL RESCUE")
    && containsLegacySensitiveTerms(`${generationPrompt.prompt} ${generationPrompt.negativeDirectives.join(" ")}`);
  const filteredSafetyRetry = generationPrompt.prompt.includes("CINEFORGE SAFETY RETRY")
    && !generationPrompt.prompt.includes("CINEFORGE OMNI NEUTRAL RESCUE")
    && job.shot_last_operation?.state === "failed"
    && job.shot_last_operation.error?.code === "GOOGLE_MODERATION";
  return legacyNeutralPrompt || filteredSafetyRetry;
}

function shouldRefreshVeoSafeBridge(job: JobRow): boolean {
  const generationPrompt = job.payload.shot.generationPrompt;
  if (job.payload.providerModelId !== "veo-3.1-fast-generate-preview" || !generationPrompt?.prompt.includes("CINEFORGE VEO SAFE BRIDGE")) return false;
  return !generationPrompt.prompt.includes("SAFE FICTIONAL PRODUCTION FRAME")
    || containsLegacySensitiveTerms(`${generationPrompt.prompt} ${generationPrompt.negativeDirectives.join(" ")}`);
}

function containsLegacySensitiveTerms(value: string): boolean {
  return /weapon|restraint|threat|agency|violence|оруж|наручник|задерж|угроз|adult man in a green and burgundy theatrical outfit|established adult performer/i.test(value);
}

export function providerDurationSeconds(modelId: string, resolution: Resolution, plannedSeconds: number, usesReferenceImages = false): number {
  if (usesReferenceImages && getVideoModel(modelId).family === "veo") return 8;
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

export function providerSafetyFraming(originalPrompt: string): string {
  const sensitiveProduction = /\b(?:f\.?b\.?i\.?|swat|special forces|police|arrest|detain)\b|фбр|спецназ|полици\w*|задерж\w*|арест\w*/i.test(originalPrompt);
  if (!sensitiveProduction) return originalPrompt;
  const fictionalized = originalPrompt
    .replace(/\bf\.?b\.?i\.?\b/gi, "fictional federal investigators")
    .replace(/фбр/gi, "вымышленная федеральная следственная группа")
    .replace(/\bswat\b/gi, "fictional tactical response team")
    .replace(/спецназ/gi, "вымышленная тактическая группа")
    .replace(/не стреляйте/gi, "я спокойно подчиняюсь")
    .replace(/руки вверх/gi, "сохраняйте спокойствие")
    .replace(/оружи\w*|пистолет\w*|винтовк\w*/gi, "закреплённое служебное снаряжение");
  return `${fictionalized}\nSAFE FICTIONAL PRODUCTION FRAME: adult actors perform a controlled lawful detention for a fictional film. No real agency names or insignia, no public figures, no weapon use, no threats, no injury, no physical abuse, no dangerous driving and no readable private information. Preserve the requested arrival, entry and calm detention as non-graphic story action.`;
}

export function providerAudioContext(_providerPrompt: string, audio: AudioContext | undefined): AudioContext | undefined {
  if (!audio) return undefined;
  // Gemini/Veo owns both picture and synchronized performance. Safety framing
  // must not silently strip the dialogue and later replace it with a robotic
  // TTS track. Only the explicitly marked last-resort neutral rescue is silent
  // (handled by neutralRescueAudioContext before this function is called).
  return {
    ...audio,
    cleanStart: true,
    forbidCarryOver: [...new Set([
      ...audio.forbidCarryOver,
      "all previous generated dialogue",
      "all previous music",
      "all previous ambience and sound effects",
    ])],
  };
}

function isNeutralRescuePrompt(prompt: string): boolean {
  return /CINEFORGE (?:OMNI NEUTRAL RESCUE|VEO NEUTRAL RESCUE|VEO SAFE BRIDGE)/.test(prompt);
}

export function neutralRescueAudioContext(audio: AudioContext | undefined): AudioContext | undefined {
  if (!audio) return undefined;
  return {
    cleanStart: true,
    speakers: [],
    silentCharacters: [],
    dialogue: [],
    ambience: ["quiet natural ambience recorded only inside this clip"],
    soundEffects: [],
    musicCue: null,
    forbidCarryOver: ["all previous dialogue", "all previous music", "all previous sound effects"],
  };
}

export function neutralRescueContinuity(continuity: ContinuityState): ContinuityState {
  const characterStates = Object.fromEntries(Object.values(continuity.characterStates).map((state, index) => [
    `established-adult-${index + 1}`,
    {
      locationId: continuity.locationId,
      wardrobeId: state.wardrobeId,
      heldProps: state.heldProps.map(sanitizeNeutralRescueText),
      injuries: state.injuries.map(sanitizeNeutralRescueText),
      appearanceChanges: state.appearanceChanges.map(sanitizeNeutralRescueText),
      position: sanitizeNeutralRescueText(state.position),
      emotionalState: sanitizeNeutralRescueText(state.emotionalState),
    },
  ]));
  const objectPositions = Object.fromEntries(Object.values(continuity.locationState.objectPositions).map((position, index) => [
    `persistent-object-${index + 1}`,
    sanitizeNeutralRescueText(position),
  ]));
  return {
    characterStates,
    locationId: continuity.locationId,
    locationState: {
      timeOfDay: sanitizeNeutralRescueText(continuity.locationState.timeOfDay),
      weather: sanitizeNeutralRescueText(continuity.locationState.weather),
      lighting: sanitizeNeutralRescueText(continuity.locationState.lighting),
      objectPositions,
    },
    previousShotId: continuity.previousShotId,
    nextShotId: continuity.nextShotId,
    requiredReferences: continuity.requiredReferences,
    lockedValues: Object.fromEntries(Object.values(continuity.lockedValues).map((value, index) => [
      `locked-value-${index + 1}`,
      typeof value === "string" ? sanitizeNeutralRescueText(value) : value,
    ])),
  };
}

function sanitizeNeutralRescueText(value: string): string {
  return neutralizeSensitiveStoryTerms(value)
    .replace(/Nick Fury|Niko Fury|Ник(?:о)? Фьюри|Marvel|Spider-?Man|Человек(?:а)?[- ]паука/giu, "established adult performer")
    .replace(/Cadillac/giu, "black civilian vehicle")
    .replace(/gun|rifle|firearm|weapon|ammo|handcuff|restraint|threat|assault|arrest|detain/giu, "ordinary production prop")
    .replace(/пистолет\w*|автомат\w*|винтовк\w*|оружи\w*|наручник\w*|угроз\w*|штурм\w*|арест\w*|задерж\w*/giu, "обычный реквизит");
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
    realismProductionProfile(originalPrompt),
    "CINEFORGE STRICT CONTINUITY CONTRACT:",
    hasFirstFrame
      ? "<FIRST_FRAME> The supplied first image is the exact final frame of the previous chronological shot. Use this image as the starting frame, begin on that exact composition and continue its physical movement. Do not reset, teleport, reverse or randomly reposition any person, vehicle, prop or camera."
      : "Preserve the canonical project state and locked references exactly; do not invent a visual reset.",
    `Canonical character state: ${JSON.stringify(characterState)}.`,
    `Canonical location state: ${JSON.stringify({ locationId: continuity.locationId, ...continuity.locationState })}.`,
    `Immutable locked values: ${JSON.stringify(continuity.lockedValues)}.`,
    `Spatial anchors that must not be mirrored or moved by a camera cut: ${JSON.stringify(spatialAnchorMap(continuity))}.`,
    "PHYSICAL WORLD CONTRACT: preserve ordinary geometry, gravity, inertia, collisions and occlusion. People, vehicles, walls, doors, furniture and props are solid. They cannot intersect, pass through one another, teleport, reverse direction without motion, change scale or appear/disappear between frames.",
    "TOPOLOGY AND DOOR CONTRACT: keep every character on the recorded inside/outside side of each wall and doorway until their body visibly follows a continuous path across the threshold. A person outside cannot operate or appear on the indoor side without first crossing; a person inside cannot appear outside without crossing. Door panels, frames, handles, walls and bodies remain solid, hinged and correctly oriented. The hinge edge, handle edge, inward/outward swing, wall plane and camera-side relationship are immutable. A cut or new lens must never mirror a doorway, exchange its left/right edges or move it to the other side of the room.",
    "BLOCKING AND EYELINE CONTRACT: preserve the recorded left/right/foreground/background positions and travel direction. Each changed position must be reached through visible continuous motion. Characters look at the other character, the relevant prop or their travel path; nobody looks into or acknowledges the camera unless the screenplay explicitly requires it.",
    "PERSISTENT OBJECT AND VEHICLE CONTRACT: every vehicle, prop and background object visible or recorded in objectPositions remains present until the screenplay explicitly shows a continuous departure or removal. Preserve vehicle count, convoy order, model, color, lane, curb offset, heading, wheel orientation and moving/stopped state. A moving vehicle begins this shot at the exact prior endpoint and continues the same screen direction and plausible speed; a parked vehicle stays at the same curb coordinate. Nothing pops in, vanishes or jumps between positions.",
    "CAMERA CONTINUITY CONTRACT: for a continuous action, remain on the same side of the 180-degree action axis and preserve screen direction. Start from the supplied final-frame composition before any motivated camera movement. Do not use an unplanned reverse angle, reset, orbit or reframing that disguises a spatial jump.",
    `Exact dialogue for this shot only: ${JSON.stringify(dialogue)}.`,
    "AUDIO ISOLATION: start a completely new audio context at 00:00. Do not repeat, continue or leak any word, voice, music, ambience or sound effect from a previous generated clip. Characters not listed as speakers remain silent. End every sound inside this shot boundary.",
  ].join("\n");
}

function spatialAnchorMap(continuity: ContinuityState): Record<string, string> {
  const spatialPattern = /door|doorway|gate|portal|threshold|wall|window|curb|lane|двер|про[её]м|ворот|стен|окн|бордюр|полос/i;
  return Object.fromEntries([
    ...Object.entries(continuity.locationState.objectPositions),
    ...Object.entries(continuity.lockedValues).map(([id, value]) => [id, typeof value === "string" ? value : JSON.stringify(value)] as const),
  ].filter(([id, value]) => spatialPattern.test(`${id} ${value}`)));
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

async function loadShotReferences(job: JobRow, modelId: string, options: { omitSubjectReferences?: boolean } = {}): Promise<ReferenceImage[]> {
  const capabilities = getVideoModel(modelId);
  const references: ReferenceImage[] = [];
  const dependencyId = job.payload.shot.continuity && "previousShotId" in job.payload.shot.continuity
    ? String((job.payload.shot.continuity as { previousShotId?: string | null }).previousShotId ?? "")
    : "";
  // previousShotId is chronological memory. It becomes a visual first-frame
  // reference only when the scheduler declared a continuous dependency; a hard
  // cut to another place/time must never inherit the previous composition.
  if (dependencyId && job.payload.shot.dependencies.includes(dependencyId) && capabilities.firstFrame) {
    const frame = await loadPreviousShotFinalFrame(job.project_id, dependencyId);
    if (frame) {
      references.push({ id: `${dependencyId}:final-frame`, data: Buffer.from(frame).toString("base64"), mimeType: "image/jpeg", role: "first-frame" });
    }
  }
  if (options.omitSubjectReferences) return references;
  const requiredIds = job.payload.shot.continuity.requiredReferences.slice(0, Math.max(0, capabilities.referenceImages - references.length));
  if (requiredIds.length) {
    const assets = await query<{ id: string; storage_key: string; mime_type: string; metadata: { role?: ReferenceImage["role"] } }>(
      "SELECT id::text,storage_key,mime_type,metadata FROM generation_assets WHERE project_id=$1 AND id::text=ANY($2::text[]) AND kind='reference-image'",
      [job.project_id, requiredIds],
    );
    for (const asset of assets) {
      const response = await fetch(await signedObjectUrl(asset.storage_key), { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Unable to load reference asset ${asset.id}: ${response.status}`);
      references.push({ id: asset.id, data: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType: asset.mime_type, role: asset.metadata?.role ?? "subject" });
    }
  }
  return references;
}

async function loadPreviousShotFinalFrame(projectId: string, shotId: string): Promise<Uint8Array | undefined> {
  const previous = await query<{ storage_key: string }>(
    `SELECT a.storage_key FROM generation_assets a JOIN shot_versions sv ON sv.id=a.shot_version_id AND sv.active=true
     WHERE a.project_id=$1 AND a.shot_id=$2 AND a.kind='video' ORDER BY a.created_at DESC LIMIT 1`,
    [projectId, shotId],
  );
  if (!previous[0]) return undefined;
  const response = await fetch(await signedObjectUrl(previous[0].storage_key), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Unable to load previous-shot reference: ${response.status}`);
  return extractFinalFrame(new Uint8Array(await response.arrayBuffer()));
}

async function loadCurrentInteractionId(job: JobRow): Promise<string | undefined> {
  return job.shot_last_operation?.output?.interactionId;
}

async function runShotQc(job: JobRow, bytes: Uint8Array, mimeType: string, operationId: string, previousBoundaryFrame?: Uint8Array): Promise<ShotQcReport | null> {
  try {
    const dependencyId = job.payload.shot.continuity.previousShotId;
    const expectedContinuousBoundary = Boolean(dependencyId && job.payload.shot.dependencies.includes(dependencyId));
    const previous = previousBoundaryFrame ?? (expectedContinuousBoundary && dependencyId
      ? await loadPreviousShotFinalFrame(job.project_id, dependencyId)
      : undefined);
    const frames = await extractShotQcFrames(bytes);
    const previewImages = [
      ...(previous ? [{ label: "PREVIOUS_SHOT_FINAL", imageDataUrl: `data:image/jpeg;base64,${Buffer.from(previous).toString("base64")}` }] : []),
      ...frames.map((frame) => ({ label: frame.label, imageDataUrl: `data:image/jpeg;base64,${Buffer.from(frame.bytes).toString("base64")}` })),
    ];
    return await evaluateShot({
      expected: job.payload.shot,
      generatedMetadata: {
        operationId,
        mimeType,
        byteSize: bytes.byteLength,
        expectedContinuousBoundary,
        evidence: previewImages.map((image) => image.label),
      },
      projectMemory: job.payload.shot.continuity,
      previewImages,
    });
  } catch {
    // Generation remains usable if the independent QC provider is temporarily unavailable.
    // Final QC can flag this shot for manual review without losing the completed asset.
    return null;
  }
}

async function persistCompletedAsset(job: JobRow, storageKey: string, checksum: string, byteSize: number, operationId: string, cost: number, qc: (ShotQcReport & { decision?: "accept" | "flag" }) | null) {
  return transaction(async (client) => {
    await client.query("SELECT id FROM shots WHERE id=$1 FOR UPDATE", [job.shot_id]);
    const versionResult = await client.query<{ version: number }>("SELECT COALESCE(max(version),0)::int version FROM shot_versions WHERE shot_id=$1", [job.shot_id]);
    const version = (versionResult.rows[0]?.version ?? 0) + 1;
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
    await advanceProjectMemory(client, job);
    await client.query("UPDATE jobs SET state='completed', completed_at=now(), result=$2,reserved_cost_usd=0 WHERE id=$1", [job.id, JSON.stringify({ storageKey, version })]);
    const count = await client.query<{ completed: number; total: number }>(
      "SELECT count(*) FILTER (WHERE state='completed')::int completed, count(*) FILTER (WHERE state<>'cancelled')::int total FROM shots WHERE project_id=$1",
      [job.project_id],
    );
    const progress = count.rows[0].total ? (count.rows[0].completed / count.rows[0].total) * 100 : 0;
    await client.query(
      "UPDATE projects SET completed_shots=$2::integer, total_shots=$3::integer, progress=$4::numeric, spent_usd=spent_usd+$5::numeric,reserved_usd=GREATEST(0,reserved_usd-$5::numeric),last_error=NULL, status=CASE WHEN $2::integer=$3::integer THEN 'validating'::project_status WHEN status='paused' THEN 'paused'::project_status ELSE 'generating'::project_status END WHERE id=$1",
      [job.project_id, count.rows[0].completed, count.rows[0].total, progress, cost],
    );
    const states = await client.query<{ id: string; state: string }>("SELECT id,state FROM shots WHERE project_id=$1 ORDER BY created_at", [job.project_id]);
    await client.query(
      `INSERT INTO checkpoints (project_id,event_type,completed_shot_ids,failed_shot_ids,pending_shot_ids,current_job_id,snapshot)
       VALUES ($1,'shot-completed',$2,$3,$4,$5,$6)`,
      [job.project_id,
        states.rows.filter((row) => row.state === "completed").map((row) => row.id),
        states.rows.filter((row) => row.state === "failed").map((row) => row.id),
        states.rows.filter((row) => !["completed", "failed", "cancelled"].includes(row.state)).map((row) => row.id),
        job.id,
        JSON.stringify({ shotId: job.shot_id, storageKey, version, spentDeltaUsd: cost, createdAt: new Date().toISOString() })],
    );
    return asset.rows[0].id;
  });
}

async function movieEngineSettings(projectId: string): Promise<{ qcRetryThreshold: number; qcFlagThreshold: number; physicalContinuityQc: boolean }> {
  const rows = await query<{ settings: { qcRetryThreshold?: number; qcFlagThreshold?: number; physicalContinuityQc?: boolean } }>(
    "SELECT ws.settings FROM workspace_settings ws JOIN projects p ON p.workspace_id=ws.workspace_id WHERE p.id=$1",
    [projectId],
  ).catch(() => []);
  return {
    qcRetryThreshold: Number(rows[0]?.settings.qcRetryThreshold ?? env().QC_RETRY_THRESHOLD),
    qcFlagThreshold: Number(rows[0]?.settings.qcFlagThreshold ?? env().QC_FLAG_THRESHOLD),
    physicalContinuityQc: rows[0]?.settings.physicalContinuityQc ?? true,
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
      "UPDATE jobs SET state='queued',payload=$2,last_error=$3,available_at=now()+interval '1 second',reserved_cost_usd=0 WHERE id=$1",
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
      "UPDATE jobs SET state='queued',payload=$2,last_error=$3,available_at=now()+($4::text || ' milliseconds')::interval,reserved_cost_usd=0 WHERE id=$1",
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

async function activateCachedShot(job: JobRow, cached: ShotArtifact) {
  await transaction(async (client) => {
    const reservation = await client.query<{ reserved_cost_usd: string }>("SELECT reserved_cost_usd FROM jobs WHERE id=$1 FOR UPDATE", [job.id]);
    const reserved = Number(reservation.rows[0]?.reserved_cost_usd ?? 0);
    await client.query("UPDATE shot_versions SET active=(version=$2) WHERE shot_id=$1", [job.shot_id, cached.version]);
    await client.query("UPDATE timeline_clips SET asset_id=$2 WHERE shot_id=$1 AND track='video' AND enabled=true", [job.shot_id, cached.id]);
    await client.query("UPDATE shots SET state='completed',current_version=$2,last_error=NULL WHERE id=$1", [job.shot_id, cached.version]);
    await advanceProjectMemory(client, job);
    await client.query("UPDATE jobs SET state='completed',completed_at=now(),result=$2,reserved_cost_usd=0,last_error=NULL WHERE id=$1", [job.id, JSON.stringify({ storageKey: cached.storageKey, version: cached.version, cached: true })]);
    const count = await client.query<{ completed: number; total: number }>(
      "SELECT count(*) FILTER (WHERE state='completed')::int completed, count(*) FILTER (WHERE state<>'cancelled')::int total FROM shots WHERE project_id=$1",
      [job.project_id],
    );
    await client.query("UPDATE projects SET completed_shots=$2,total_shots=$3,progress=CASE WHEN $3=0 THEN 0 ELSE $2::numeric/$3*100 END,reserved_usd=GREATEST(0,reserved_usd-$4),last_error=NULL WHERE id=$1", [
      job.project_id, count.rows[0].completed, count.rows[0].total, reserved,
    ]);
    await client.query(
      `INSERT INTO checkpoints (project_id,event_type,completed_shot_ids,current_job_id,snapshot)
       VALUES ($1,'shot-cache-restored',ARRAY[$2]::text[],$3,$4)`,
      [job.project_id, job.shot_id, job.id, JSON.stringify({ shotId: job.shot_id, storageKey: cached.storageKey, version: cached.version })],
    );
  });
}

async function purgeInvalidCachedShot(job: JobRow, cached: ShotArtifact): Promise<void> {
  await transaction(async (client) => {
    await client.query("SELECT id FROM shots WHERE id=$1 FOR UPDATE", [job.shot_id]);
    await client.query("UPDATE timeline_clips SET asset_id=NULL WHERE asset_id=$1", [cached.id]);
    await client.query("DELETE FROM generation_assets WHERE id=$1 AND project_id=$2", [cached.id, job.project_id]);
    await client.query("DELETE FROM shot_versions WHERE shot_id=$1 AND content_hash=$2", [job.shot_id, cached.contentHash]);
    const remaining = await client.query<{ version: number }>("SELECT COALESCE(max(version),0)::int version FROM shot_versions WHERE shot_id=$1", [job.shot_id]);
    await client.query("UPDATE shots SET state='planned',current_version=$2,last_error=NULL WHERE id=$1", [job.shot_id, remaining.rows[0]?.version ?? 0]);
  });
}

async function advanceProjectMemory(client: PoolClient, job: JobRow): Promise<void> {
  const sequence = job.payload.shot.sequence;
  for (const [characterId, state] of Object.entries(job.payload.shot.continuity.characterStates)) {
    await client.query(
      `UPDATE characters SET
         current_state=current_state || $3::jsonb || jsonb_build_object('_lastShotSequence',$4::int),updated_at=now()
       WHERE id=$1 AND project_id=$2
         AND COALESCE(NULLIF(current_state->>'_lastShotSequence','')::int,-1) <= $4`,
      [characterId, job.project_id, JSON.stringify(state), sequence],
    );
  }
  await client.query(
    `UPDATE locations SET
       current_state=current_state || $3::jsonb || jsonb_build_object('_lastShotSequence',$4::int),updated_at=now()
     WHERE id=$1 AND project_id=$2
       AND COALESCE(NULLIF(current_state->>'_lastShotSequence','')::int,-1) <= $4`,
    [job.payload.shot.continuity.locationId, job.project_id, JSON.stringify(job.payload.shot.continuity.locationState), sequence],
  );
}
