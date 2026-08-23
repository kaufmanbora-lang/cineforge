import { createHash } from "node:crypto";
import { openAIClient } from "@/server/providers/openai";
import { query, transaction } from "@/server/db";
import { patchDialogueAudio } from "@/server/movie/ffmpeg";
import { getObjectIfExists, putObject, signedObjectUrl } from "@/server/storage";
import { enqueueAutomaticAssemblyIfReady } from "@/server/movie/queue";
import type { AudioContext, MoviePlan, Shot } from "@/domain/movie";

const BUILT_IN_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"] as const;

interface DialogueJobRow {
  id: string;
  project_id: string;
  scene_id: string;
  shot_id: string;
  payload: {
    dialogueId?: string;
    characterId?: string;
    text?: string;
    delivery?: string;
    startSeconds?: number;
    durationSeconds?: number;
    dialogueSegments?: Array<{ id: string; characterId: string; text: string; delivery: string; startSeconds: number; durationSeconds: number }>;
    originalAssetId: string;
    originalStorageKey: string;
  };
}

export async function processDialoguePatch(databaseJobId: string) {
  const rows = await query<DialogueJobRow>(
    `UPDATE jobs SET state='generating',started_at=COALESCE(started_at,now()),attempt=attempt+1,updated_at=now()
     WHERE id=$1 AND state IN ('queued','retrying') RETURNING *`,
    [databaseJobId],
  );
  const job = rows[0];
  if (!job) return { skipped: true, videoFramesPreserved: true };
  const heartbeat = setInterval(() => {
    void query("UPDATE jobs SET updated_at=now() WHERE id=$1 AND state='generating'", [job.id]).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  try {
  const segments = job.payload.dialogueSegments ?? (job.payload.dialogueId && job.payload.characterId && job.payload.text && job.payload.delivery && job.payload.startSeconds !== undefined && job.payload.durationSeconds !== undefined ? [{ id: job.payload.dialogueId, characterId: job.payload.characterId, text: job.payload.text, delivery: job.payload.delivery, startSeconds: job.payload.startSeconds, durationSeconds: job.payload.durationSeconds }] : []);
  if (!segments.length) throw new Error("Dialogue patch contains no dialogue segments.");
  const contentHash = createHash("sha256").update(JSON.stringify(job.payload)).digest("hex");
  const storageKey = `projects/${job.project_id}/scenes/${job.scene_id}/shots/${job.shot_id}/dialogue-${contentHash}.mp4`;
  const cached = await getObjectIfExists(storageKey);
  let patched: Uint8Array;
  if (cached) {
    patched = cached.bytes;
  } else {
    const client = await openAIClient();
    const sourceResponse = await fetch(await signedObjectUrl(job.payload.originalStorageKey), { signal: AbortSignal.timeout(120_000) });
    if (!sourceResponse.ok) throw new Error(`Unable to download original shot: ${sourceResponse.status}`);
    patched = new Uint8Array(await sourceResponse.arrayBuffer());
    for (const segment of segments) {
      const characters = await query<{ bible: { voice?: { providerVoiceId?: string | null; description?: string } } }>(
        "SELECT bible FROM characters WHERE id=$1 AND project_id=$2",
        [segment.characterId, job.project_id],
      );
      const requestedVoice = characters[0]?.bible.voice?.providerVoiceId;
      const voice = requestedVoice && BUILT_IN_VOICES.includes(requestedVoice as (typeof BUILT_IN_VOICES)[number])
        ? requestedVoice
        : deterministicVoice(segment.characterId);
      const speechResponse = await client.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: voice as never,
        input: segment.text,
        instructions: `${characters[0]?.bible.voice?.description ?? "Natural cinematic dialogue"}. Delivery: ${segment.delivery}. Maintain the same character voice identity.`,
        response_format: "mp3",
      });
      patched = await patchDialogueAudio({
        video: patched,
        speech: new Uint8Array(await speechResponse.arrayBuffer()),
        startSeconds: segment.startSeconds,
        endSeconds: segment.startSeconds + segment.durationSeconds,
      });
    }
    await putObject(storageKey, patched, "video/mp4");
  }
  const checksum = createHash("sha256").update(patched).digest("hex");
  await transaction(async (db) => {
    const current = await db.query<{ current_version: number; audio_context: AudioContext; generation_spec: Shot }>("SELECT current_version,audio_context,generation_spec FROM shots WHERE id=$1 FOR UPDATE", [job.shot_id]);
    if (!current.rows[0]) throw new Error("Dialogue source shot no longer exists.");
    const maximumVersion = await db.query<{ version: number }>("SELECT COALESCE(max(version),0)::int version FROM shot_versions WHERE shot_id=$1", [job.shot_id]);
    const version = (maximumVersion.rows[0]?.version ?? 0) + 1;
    const replacementById = new Map(segments.map((segment) => [segment.id, segment]));
    const revisedAudio: AudioContext = {
      ...current.rows[0].audio_context,
      dialogue: current.rows[0].audio_context.dialogue.map((line) => {
        const replacement = replacementById.get(line.id);
        return replacement ? { ...line, text: replacement.text, delivery: replacement.delivery } : line;
      }),
    };
    const revisedSpec = { ...current.rows[0].generation_spec, audioContext: revisedAudio };
    await db.query("UPDATE shot_versions SET active=false WHERE shot_id=$1", [job.shot_id]);
    const shotVersion = await db.query<{ id: string }>(
      `INSERT INTO shot_versions (shot_id,version,reason,generation_spec,content_hash,active)
       VALUES ($1,$2,'edited dialogue',$3,$4,true) RETURNING id`,
      [job.shot_id, version, JSON.stringify(revisedSpec), contentHash],
    );
    const asset = await db.query<{ id: string }>(
      `INSERT INTO generation_assets (project_id,scene_id,shot_id,shot_version_id,kind,storage_key,mime_type,byte_size,checksum,metadata)
       VALUES ($1,$2,$3,$4,'video',$5,'video/mp4',$6,$7,$8) RETURNING id`,
      [job.project_id, job.scene_id, job.shot_id, shotVersion.rows[0].id, storageKey, patched.byteLength, checksum,
        JSON.stringify({ videoFramesPreserved: true, sourceAssetId: job.payload.originalAssetId, dialogueIds: segments.map((segment) => segment.id) })],
    );
    await db.query("UPDATE timeline_clips SET asset_id=$2 WHERE shot_id=$1 AND track='video' AND enabled=true", [job.shot_id, asset.rows[0].id]);
    await db.query("UPDATE shots SET current_version=$2,state='completed',audio_context=$3,generation_spec=$4 WHERE id=$1", [job.shot_id, version, JSON.stringify(revisedAudio), JSON.stringify(revisedSpec)]);
    await db.query("UPDATE timeline_clips SET metadata=$2 WHERE shot_id=$1 AND track='dialogue' AND enabled=true", [job.shot_id, JSON.stringify({ dialogue: revisedAudio.dialogue })]);
    await db.query("UPDATE timeline_clips SET metadata=$2 WHERE shot_id=$1 AND track='subtitles' AND enabled=true", [job.shot_id, JSON.stringify({ lines: revisedAudio.dialogue.map((line) => ({ id: line.id, text: line.text, startSeconds: line.startSeconds, durationSeconds: line.durationSeconds })) })]);

    const planRows = await db.query<{ current_plan_version: number; maximum_plan_version: number; plan: MoviePlan }>(
      `SELECT m.version current_plan_version,
          (SELECT COALESCE(max(version),0)::int FROM movie_plan_versions WHERE project_id=p.id) maximum_plan_version,
          m.plan FROM projects p
        JOIN LATERAL (
          SELECT version,plan FROM movie_plan_versions
          WHERE project_id=p.id
          ORDER BY version=p.current_plan_version DESC,version DESC LIMIT 1
        ) m ON true
       WHERE p.id=$1 FOR UPDATE OF p`,
      [job.project_id],
    );
    if (planRows.rows[0]) {
      const nextPlan: MoviePlan = {
        ...planRows.rows[0].plan,
        scenes: planRows.rows[0].plan.scenes.map((scene) => ({
          ...scene,
          shots: scene.shots.map((shot) => shot.id === job.shot_id ? { ...shot, audioContext: revisedAudio } : shot),
        })),
      };
      const nextPlanVersion = planRows.rows[0].maximum_plan_version + 1;
      const planHash = createHash("sha256").update(JSON.stringify(nextPlan)).digest("hex");
      const savedPlan = await db.query<{ version: number }>(
        `INSERT INTO movie_plan_versions (project_id,version,content_hash,plan) VALUES ($1,$2,$3,$4)
         ON CONFLICT (project_id,content_hash) DO UPDATE SET plan=EXCLUDED.plan RETURNING version`,
        [job.project_id, nextPlanVersion, planHash, JSON.stringify(nextPlan)],
      );
      await db.query("UPDATE projects SET current_plan_version=$2,updated_at=now() WHERE id=$1", [job.project_id, savedPlan.rows[0].version]);
    }
    await db.query("UPDATE jobs SET state='completed',completed_at=now(),result=$2 WHERE id=$1", [job.id, JSON.stringify({ storageKey, version, videoFramesPreserved: true })]);
    await db.query(
      `INSERT INTO checkpoints (project_id,event_type,completed_shot_ids,pending_shot_ids,snapshot)
       VALUES ($1,'dialogue-patched',ARRAY[$2]::text[],'{}'::text[],$3)`,
      [job.project_id, job.shot_id, JSON.stringify({ dialogueIds: segments.map((segment) => segment.id), version, sourceAssetId: job.payload.originalAssetId })],
    );
  });
  await enqueueAutomaticAssemblyIfReady(job.project_id);
  return { storageKey, videoFramesPreserved: true };
  } finally {
    clearInterval(heartbeat);
  }
}

function deterministicVoice(characterId: string): string {
  const value = [...characterId].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return BUILT_IN_VOICES[value % BUILT_IN_VOICES.length];
}
