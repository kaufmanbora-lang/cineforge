import { createHash } from "node:crypto";
import { query, transaction } from "@/server/db";
import { getProviderKey } from "@/server/provider-secrets";
import { googleVideoAdapter } from "@/server/providers/video/google";
import type { VideoGenerationRequest } from "@/server/providers/video/types";
import { putObject, signedObjectUrl } from "@/server/storage";
import { findCachedShot } from "@/server/movie/repository";
import { classifyFailure, retryDecision } from "@/server/movie/retry";
import { enqueueAutomaticAssemblyIfReady, enqueueDialoguePatch, enqueueReadyProjectJobs, pauseProjectJobs, requeueDatabaseJob } from "@/server/movie/queue";
import { getVideoModel, type Resolution } from "@/domain/video-models";
import { env } from "@/server/env";
import { contentHash } from "@/server/movie/content-hash";
import { extractFinalFrame, extractRepresentativeFrame } from "@/server/movie/ffmpeg";
import { evaluateShot, type ShotQcReport } from "@/server/providers/openai";
import type { ReferenceImage } from "@/server/providers/video/types";

interface JobRow {
  id: string;
  project_id: string;
  scene_id: string;
  shot_id: string;
  attempt: number;
  max_attempts: number;
  state: string;
  available_at: string;
  payload: { shot: { durationSeconds: number; generationPrompt?: { prompt: string; negativeDirectives: string[]; seed: number | null }; continuity: { requiredReferences: string[] }; audioContext?: { dialogue: Array<{ id: string; characterId: string; text: string; delivery: string; startSeconds: number; durationSeconds: number }> } }; specHash: string };
  model_id: string;
  resolution: Resolution;
  aspect_ratio: "16:9" | "9:16";
  render_tier: "draft" | "final";
  maximum_budget_usd: string;
  spent_usd: string;
  reserved_usd: string;
  reserved_cost_usd: string;
}

export async function processShot(databaseJobId: string): Promise<{ cached: boolean; storageKey: string; retrying?: boolean }> {
  const rows = await query<JobRow>(
    `SELECT j.*, p.model_id, p.resolution, p.aspect_ratio, p.render_tier, p.maximum_budget_usd, p.spent_usd, p.reserved_usd
     FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=$1`,
    [databaseJobId],
  );
  const job = rows[0];
  if (!job) throw new Error("Generation job not found.");
  if (["completed", "paused", "failed", "cancelled", "planned", "generating", "validating"].includes(job.state)) {
    return { cached: false, storageKey: "", retrying: ["planned", "generating", "validating"].includes(job.state) };
  }
  if (job.state === "retrying" && new Date(job.available_at).getTime() > Date.now()) {
    return { cached: false, storageKey: "", retrying: true };
  }
  const cached = await findCachedShot(job.project_id, job.shot_id, job.payload.specHash);
  if (cached) {
    await markCompleted(job, cached.storageKey, 0, true);
    await enqueueReadyProjectJobs(job.project_id);
    await enqueueAutomaticAssemblyIfReady(job.project_id);
    return { cached: true, storageKey: cached.storageKey };
  }
  const capabilities = getVideoModel(job.model_id);
  const price = capabilities.pricePerSecondUsd[job.resolution] ?? capabilities.pricePerSecondUsd["720p"] ?? 0;
  const projectedCost = job.payload.shot.durationSeconds * price;
  if (!await reserveBudget(job.id, job.project_id, projectedCost)) {
    await pauseProjectJobs(job.project_id, { code: "BUDGET_REACHED", message: "Maximum generation budget reached." });
    throw new Error("Maximum generation budget reached; project paused.");
  }
  let providerCompleted = false;
  try {
    const apiKey = await getProviderKey("google");
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
    await query("UPDATE jobs SET state='generating', started_at=COALESCE(started_at,now()), attempt=attempt+1 WHERE id=$1", [job.id]);
    const prompt = job.payload.shot.generationPrompt;
    if (!prompt) throw new Error("Shot has no generation prompt.");
    const request: VideoGenerationRequest = {
      projectId: job.project_id,
      sceneId: job.scene_id,
      shotId: job.shot_id,
      modelId: job.model_id,
      prompt: prompt.prompt,
      negativeDirectives: prompt.negativeDirectives,
      durationSeconds: job.payload.shot.durationSeconds,
      resolution: job.resolution,
      aspectRatio: job.aspect_ratio,
      seed: prompt.seed,
      references: await loadShotReferences(job),
      fastMode: job.render_tier === "draft",
    };
    const adapter = googleVideoAdapter(job.model_id);
    let operation = await adapter.start(request, apiKey);
    await query("UPDATE shots SET last_operation=$2 WHERE id=$1", [job.shot_id, JSON.stringify(operation)]);
    while (operation.state === "pending") {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      operation = await adapter.poll(operation, apiKey);
      await query("UPDATE shots SET last_operation=$2 WHERE id=$1", [job.shot_id, JSON.stringify(operation)]);
    }
    if (operation.state === "failed" || !operation.output) {
      const error = new Error(operation.error?.message ?? "Video generation failed.");
      Object.assign(error, { status: operation.error?.status, code: operation.error?.code });
      throw error;
    }
    providerCompleted = true;
    const cost = projectedCost;
    const checksum = createHash("sha256").update(operation.output.bytes).digest("hex");
    await query("UPDATE jobs SET state='validating' WHERE id=$1", [job.id]);
    // Fast Draft is the interactive path: publish the provider result immediately.
    // Expensive vision QC and consistent-voice replacement remain enabled for Final.
    const qc = job.render_tier === "draft"
      ? null
      : await runShotQc(job, operation.output.bytes, operation.output.mimeType, operation.operationId);
    const engineSettings = await movieEngineSettings(job.project_id);
    if (qc && qc.overall < engineSettings.qcRetryThreshold && job.attempt + 1 < job.max_attempts) {
      const retryPrompt = `${prompt.prompt}\nQC CORRECTION FOR THIS SHOT ONLY: ${qc.retryInstruction ?? qc.issues.join("; ")}. Preserve all unaffected details and locked values.`;
      const nextPayload = {
        ...job.payload,
        shot: { ...job.payload.shot, generationPrompt: { ...prompt, prompt: retryPrompt } },
      };
      nextPayload.specHash = contentHash({ shot: nextPayload.shot, qcCorrection: qc.retryInstruction ?? qc.issues });
      const rejectedKey = `projects/${job.project_id}/scenes/${job.scene_id}/shots/${job.shot_id}/qc-rejected-${job.attempt + 1}-${checksum.slice(0, 12)}.mp4`;
      await putObject(rejectedKey, operation.output.bytes, operation.output.mimeType);
      const delayMs = Math.min(60_000, 2_000 * 2 ** Math.max(0, job.attempt));
      await persistQcRetry(job, { storageKey: rejectedKey, checksum, byteSize: operation.output.bytes.byteLength, cost, qc, nextPayload, delayMs });
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt + 1, delayMs });
      return { cached: false, storageKey: rejectedKey, retrying: true };
    }
    const storageKey = `projects/${job.project_id}/scenes/${job.scene_id}/shots/${job.shot_id}/${job.payload.specHash}.mp4`;
    await putObject(storageKey, operation.output.bytes, operation.output.mimeType);
    const classifiedQc: (ShotQcReport & { decision: "accept" | "flag" }) | null = qc
      ? { ...qc, decision: qc.overall < engineSettings.qcFlagThreshold ? "flag" : "accept" }
      : null;
    const assetId = await persistCompletedAsset(job, storageKey, checksum, operation.output.bytes.byteLength, operation.operationId, cost, classifiedQc);
    const dialogueSegments = job.payload.shot.audioContext?.dialogue ?? [];
    if (dialogueSegments.length && job.render_tier === "final") {
      const dialoguePayload = { dialogueSegments, originalAssetId: assetId, originalStorageKey: storageKey };
      await enqueueDialoguePatch({
        projectId: job.project_id,
        sceneId: job.scene_id,
        shotId: job.shot_id,
        payload: dialoguePayload,
        idempotencyKey: `dialogue-master:${job.shot_id}:${contentHash(dialoguePayload)}`,
      });
    }
    await enqueueReadyProjectJobs(job.project_id);
    await enqueueAutomaticAssemblyIfReady(job.project_id);
    return { cached: false, storageKey };
  } catch (error) {
    await settleFailedReservation(job.id, job.project_id, providerCompleted);
    const failure = classifyFailure(error);
    const decision = retryDecision({ failure, attempt: job.attempt + 1, maxAttempts: job.max_attempts });
    if (decision.pauseProject) await pauseProjectJobs(job.project_id, { code: failure, message: error instanceof Error ? error.message : String(error) });
    await query(
      "UPDATE jobs SET state=$2, last_error=$3, available_at=now()+($4::text || ' milliseconds')::interval WHERE id=$1",
      [job.id, decision.pauseProject ? "paused" : decision.retry ? "retrying" : "failed", JSON.stringify({ failure, message: error instanceof Error ? error.message : String(error) }), decision.delayMs],
    );
    if (!decision.pauseProject && !decision.retry) await query("UPDATE projects SET status='failed',last_error=$2 WHERE id=$1", [job.project_id, JSON.stringify({ failure, message: error instanceof Error ? error.message : String(error), shotId: job.shot_id })]);
    if (decision.retry) {
      await requeueDatabaseJob({ databaseJobId: job.id, attempt: job.attempt + 1, delayMs: decision.delayMs });
    }
    throw error;
  }
}

async function loadShotReferences(job: JobRow): Promise<ReferenceImage[]> {
  const capabilities = getVideoModel(job.model_id);
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
    await client.query("UPDATE shots SET state='completed', current_version=$2, retry_count=$3, last_error=NULL WHERE id=$1", [job.shot_id, version, job.attempt + 1]);
    await client.query("UPDATE jobs SET state='completed', completed_at=now(), result=$2,reserved_cost_usd=0 WHERE id=$1", [job.id, JSON.stringify({ storageKey, version })]);
    const count = await client.query<{ completed: number; total: number }>(
      "SELECT count(*) FILTER (WHERE state='completed')::int completed, count(*)::int total FROM shots WHERE project_id=$1",
      [job.project_id],
    );
    const progress = count.rows[0].total ? (count.rows[0].completed / count.rows[0].total) * 100 : 0;
    await client.query(
      "UPDATE projects SET completed_shots=$2, total_shots=$3, progress=$4, spent_usd=spent_usd+$5,reserved_usd=GREATEST(0,reserved_usd-$5), status=CASE WHEN $2=$3 THEN 'validating'::project_status ELSE 'generating'::project_status END WHERE id=$1",
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
      [job.project_id, job.scene_id, job.shot_id, input.storageKey, input.byteSize, job.payload.shot.durationSeconds, input.checksum, JSON.stringify({ qc: input.qc, retryAttempt: job.attempt + 1 })],
    );
    await client.query(
      "UPDATE jobs SET state='retrying',payload=$2,last_error=$3,available_at=now()+($4::text || ' milliseconds')::interval,reserved_cost_usd=0 WHERE id=$1",
      [job.id, JSON.stringify(input.nextPayload), JSON.stringify({ code: "QC_RETRY", report: input.qc }), input.delayMs],
    );
    await client.query("UPDATE shots SET state='retrying',retry_count=$2,last_error=$3 WHERE id=$1", [job.shot_id, job.attempt + 1, JSON.stringify({ qc: input.qc })]);
    await client.query("UPDATE projects SET spent_usd=spent_usd+$2,reserved_usd=GREATEST(0,reserved_usd-$2),status='generating' WHERE id=$1", [job.project_id, input.cost]);
    await client.query(
      `INSERT INTO checkpoints (project_id,event_type,failed_shot_ids,pending_shot_ids,current_job_id,snapshot)
       VALUES ($1,'shot-qc-retry','{}'::text[],ARRAY[$2]::text[],$3,$4)`,
      [job.project_id, job.shot_id, job.id, JSON.stringify({ shotId: job.shot_id, qc: input.qc, retryAttempt: job.attempt + 1, rejectedStorageKey: input.storageKey })],
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
