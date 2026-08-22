import { createHash } from "node:crypto";
import { openAIClient } from "@/server/providers/openai";
import { query, transaction } from "@/server/db";
import { patchDialogueAudio } from "@/server/movie/ffmpeg";
import { putObject, signedObjectUrl } from "@/server/storage";
import { enqueueAutomaticAssemblyIfReady } from "@/server/movie/queue";

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
  const rows = await query<DialogueJobRow>("SELECT * FROM jobs WHERE id=$1", [databaseJobId]);
  const job = rows[0];
  if (!job) throw new Error("Dialogue patch job not found.");
  await query("UPDATE jobs SET state='generating',started_at=COALESCE(started_at,now()),attempt=attempt+1 WHERE id=$1", [job.id]);
  const client = await openAIClient();
  const sourceResponse = await fetch(await signedObjectUrl(job.payload.originalStorageKey));
  if (!sourceResponse.ok) throw new Error(`Unable to download original shot: ${sourceResponse.status}`);
  let patched: Uint8Array = new Uint8Array(await sourceResponse.arrayBuffer());
  const segments = job.payload.dialogueSegments ?? (job.payload.dialogueId && job.payload.characterId && job.payload.text && job.payload.delivery && job.payload.startSeconds !== undefined && job.payload.durationSeconds !== undefined ? [{ id: job.payload.dialogueId, characterId: job.payload.characterId, text: job.payload.text, delivery: job.payload.delivery, startSeconds: job.payload.startSeconds, durationSeconds: job.payload.durationSeconds }] : []);
  if (!segments.length) throw new Error("Dialogue patch contains no dialogue segments.");
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
  const checksum = createHash("sha256").update(patched).digest("hex");
  const contentHash = createHash("sha256").update(JSON.stringify(job.payload)).digest("hex");
  const storageKey = `projects/${job.project_id}/scenes/${job.scene_id}/shots/${job.shot_id}/dialogue-${contentHash}.mp4`;
  await putObject(storageKey, patched, "video/mp4");
  await transaction(async (db) => {
    const current = await db.query<{ current_version: number }>("SELECT current_version FROM shots WHERE id=$1 FOR UPDATE", [job.shot_id]);
    const version = (current.rows[0]?.current_version ?? 0) + 1;
    await db.query("UPDATE shot_versions SET active=false WHERE shot_id=$1", [job.shot_id]);
    const shotVersion = await db.query<{ id: string }>(
      `INSERT INTO shot_versions (shot_id,version,reason,generation_spec,content_hash,active)
       VALUES ($1,$2,'edited dialogue',$3,$4,true) RETURNING id`,
      [job.shot_id, version, JSON.stringify(job.payload), contentHash],
    );
    const asset = await db.query<{ id: string }>(
      `INSERT INTO generation_assets (project_id,scene_id,shot_id,shot_version_id,kind,storage_key,mime_type,byte_size,checksum,metadata)
       VALUES ($1,$2,$3,$4,'video',$5,'video/mp4',$6,$7,$8) RETURNING id`,
      [job.project_id, job.scene_id, job.shot_id, shotVersion.rows[0].id, storageKey, patched.byteLength, checksum,
        JSON.stringify({ videoFramesPreserved: true, sourceAssetId: job.payload.originalAssetId, dialogueIds: segments.map((segment) => segment.id) })],
    );
    await db.query("UPDATE timeline_clips SET asset_id=$2 WHERE shot_id=$1 AND track='video' AND enabled=true", [job.shot_id, asset.rows[0].id]);
    await db.query("UPDATE shots SET current_version=$2,state='completed' WHERE id=$1", [job.shot_id, version]);
    await db.query("UPDATE jobs SET state='completed',completed_at=now(),result=$2 WHERE id=$1", [job.id, JSON.stringify({ storageKey, version, videoFramesPreserved: true })]);
    await db.query(
      `INSERT INTO checkpoints (project_id,event_type,completed_shot_ids,pending_shot_ids,snapshot)
       VALUES ($1,'dialogue-patched',ARRAY[$2]::text[],'{}'::text[],$3)`,
      [job.project_id, job.shot_id, JSON.stringify({ dialogueIds: segments.map((segment) => segment.id), version, sourceAssetId: job.payload.originalAssetId })],
    );
  });
  await enqueueAutomaticAssemblyIfReady(job.project_id);
  return { storageKey, videoFramesPreserved: true };
}

function deterministicVoice(characterId: string): string {
  const value = [...characterId].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return BUILT_IN_VOICES[value % BUILT_IN_VOICES.length];
}
