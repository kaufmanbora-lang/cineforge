import type { PoolClient } from "pg";
import { scopeMoviePlanIds, type MoviePlan, type ProjectRecord, type Scene, type ShotArtifact } from "@/domain/movie";
import { contentHash } from "./content-hash";
import { transaction, query } from "@/server/db";

export async function persistMoviePlan(plan: MoviePlan): Promise<void> {
  const projectReferences = await query<{ id: string }>(
    `SELECT id::text FROM generation_assets
     WHERE project_id=$1 AND kind='reference-image' AND COALESCE(metadata->>'role','subject')='subject'
     ORDER BY created_at`,
    [plan.projectId],
  );
  plan = attachPrimaryCharacterReferences(plan, projectReferences.map((row) => row.id));
  plan = scopeMoviePlanIds(plan);
  const hash = contentHash(plan);
  await transaction(async (client) => {
    const versionResult = await client.query<{ current_plan_version: number }>(
      "SELECT current_plan_version FROM projects WHERE id = $1 FOR UPDATE",
      [plan.projectId],
    );
    if (!versionResult.rows[0]) throw new Error("Project not found.");
    const maximumVersion = await client.query<{ version: number }>(
      "SELECT COALESCE(max(version),0)::int version FROM movie_plan_versions WHERE project_id=$1",
      [plan.projectId],
    );
    const existingPlan = await client.query<{ version: number }>(
      "SELECT version FROM movie_plan_versions WHERE project_id=$1 AND content_hash=$2",
      [plan.projectId, hash],
    );
    if (existingPlan.rows[0]?.version === versionResult.rows[0].current_plan_version) {
      await client.query(
        `UPDATE projects SET title=$2,total_shots=$3,
           status=CASE WHEN status IN ('draft','planning','planned','failed') THEN 'planned'::project_status ELSE status END,
           updated_at=now() WHERE id=$1`,
        [plan.projectId, plan.summary.title, plan.scenes.reduce((sum, scene) => sum + scene.shots.length, 0)],
      );
      return;
    }
    const rendered = await client.query<{ count: number }>(
      `SELECT count(*)::int count FROM shot_versions sv
       JOIN shots s ON s.id=sv.shot_id WHERE s.project_id=$1`,
      [plan.projectId],
    );
    if (rendered.rows[0].count > 0) {
      throw Object.assign(
        new Error("Полная замена сценария запрещена после создания кадров. Используйте точечную правку в редакторе — готовые сцены останутся неизменными."),
        { status: 409 },
      );
    }
    // A pre-render screenplay can be replaced safely. Remove only its unrendered
    // graph so changed LLM IDs cannot collide with the unique project/number
    // constraints. Plan history, conversations, references and checkpoints stay.
    await client.query("DELETE FROM acts WHERE project_id=$1", [plan.projectId]);
    await client.query("DELETE FROM characters WHERE project_id=$1", [plan.projectId]);
    await client.query("DELETE FROM locations WHERE project_id=$1", [plan.projectId]);
    // The versions table is authoritative. This also repairs projects created
    // by an older build that advanced current_plan_version after a conflict.
    const version = Math.max(versionResult.rows[0].current_plan_version, maximumVersion.rows[0].version) + 1;
    const savedPlan = await client.query<{ version: number }>(
      `INSERT INTO movie_plan_versions (project_id, version, content_hash, plan)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, content_hash) DO UPDATE SET plan=EXCLUDED.plan
       RETURNING version`,
      [plan.projectId, version, hash, JSON.stringify(plan)],
    );
    const storedVersion = savedPlan.rows[0].version;
    const currentShotIds = plan.scenes.flatMap((scene) => scene.shots.map((shot) => shot.id));
    await client.query(
      "UPDATE jobs SET state='cancelled',updated_at=now() WHERE project_id=$1 AND shot_id IS NOT NULL AND NOT (shot_id=ANY($2::text[])) AND state NOT IN ('completed','cancelled')",
      [plan.projectId, currentShotIds],
    );
    await client.query(
      "UPDATE shots SET state='cancelled',updated_at=now() WHERE project_id=$1 AND NOT (id=ANY($2::text[]))",
      [plan.projectId, currentShotIds],
    );
    await client.query("UPDATE projects SET title = $2, current_plan_version = $3, status = 'planned', total_shots = $4 WHERE id = $1", [
      plan.projectId,
      plan.summary.title,
      storedVersion,
      plan.scenes.reduce((sum, scene) => sum + scene.shots.length, 0),
    ]);
    await client.query("UPDATE timeline_clips SET enabled=false WHERE project_id=$1 AND enabled=true", [plan.projectId]);

    for (const character of plan.characters) {
      const firstState = plan.scenes.flatMap((scene) => scene.shots)
        .map((shot) => shot.continuity.characterStates[character.id])
        .find(Boolean);
      await client.query(
        `INSERT INTO characters (id, project_id, name, bible, current_state, locks)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET bible = EXCLUDED.bible, locks = EXCLUDED.locks`,
        [character.id, plan.projectId, character.name, JSON.stringify(character), JSON.stringify({ ...(firstState ?? {}), _lastShotSequence: 0 }), JSON.stringify(character.locks)],
      );
    }
    for (const location of plan.locations) {
      const firstState = plan.scenes.flatMap((scene) => scene.shots)
        .find((shot) => shot.continuity.locationId === location.id)?.continuity.locationState;
      await client.query(
        `INSERT INTO locations (id, project_id, name, bible, current_state, locks)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET bible = EXCLUDED.bible, locks = EXCLUDED.locks`,
        [location.id, plan.projectId, location.name, JSON.stringify(location), JSON.stringify({ ...(firstState ?? {}), _lastShotSequence: 0 }), JSON.stringify({ design: location.designLocked })],
      );
    }
    for (const act of plan.acts) {
      await client.query(
        `INSERT INTO acts (id, project_id, number, title, purpose, sort_order)
         VALUES ($1, $2, $3, $4, $5, $3)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, purpose = EXCLUDED.purpose, sort_order = EXCLUDED.sort_order`,
        [act.id, plan.projectId, act.number, act.title, act.purpose],
      );
      const sequenceId = plan.scenes.find((scene) => scene.actId === act.id)?.sequenceId ?? `sequence-${act.number}`;
      await client.query(
        `INSERT INTO sequences (id, project_id, act_id, number, title, sort_order)
         VALUES ($1, $2, $3, $4, $5, $4)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
        [sequenceId, plan.projectId, act.id, act.number, act.title],
      );
    }
    let timelineCursor = 0;
    for (const scene of plan.scenes) {
      timelineCursor = await persistScene(client, plan.projectId, scene, storedVersion, timelineCursor);
    }
    const counts = await client.query<{ completed: number; total: number }>(
      "SELECT count(*) FILTER (WHERE state='completed')::int completed,count(*) FILTER (WHERE state<>'cancelled')::int total FROM shots WHERE project_id=$1",
      [plan.projectId],
    );
    await client.query(
      `UPDATE projects SET completed_shots=$2::integer,total_shots=$3::integer,
         progress=CASE WHEN $3::integer=0 THEN 0 ELSE ($2::integer)::numeric/($3::integer)*100 END WHERE id=$1`,
      [plan.projectId, counts.rows[0].completed, counts.rows[0].total],
    );
  });
}

export function attachPrimaryCharacterReferences(plan: MoviePlan, referenceAssetIds: string[]): MoviePlan {
  const primaryCharacter = plan.characters[0];
  const references = [...new Set(referenceAssetIds)];
  if (!primaryCharacter || !references.length) return plan;
  return {
    ...plan,
    characters: plan.characters.map((character, index) => index === 0 ? {
      ...character,
      referenceAssetIds: [...new Set([...character.referenceAssetIds, ...references])],
      locks: { ...character.locks, appearance: true, outfit: true, voice: true },
    } : character),
    scenes: plan.scenes.map((scene) => ({
      ...scene,
      shots: scene.shots.map((shot) => scene.characterIds.includes(primaryCharacter.id) ? {
        ...shot,
        continuity: {
          ...shot.continuity,
          requiredReferences: [...new Set([...shot.continuity.requiredReferences, ...references])],
          lockedValues: {
            ...shot.continuity.lockedValues,
            [`${primaryCharacter.id}.appearanceReferenceAssetIds`]: references,
          },
        },
        generationPrompt: shot.generationPrompt ? {
          ...shot.generationPrompt,
          referenceAssetIds: [...new Set([...shot.generationPrompt.referenceAssetIds, ...references])],
        } : shot.generationPrompt,
      } : shot),
    })),
  };
}

async function persistScene(client: PoolClient, projectId: string, scene: Scene, planVersion: number, startSeconds: number): Promise<number> {
  const sceneHash = contentHash(scene);
  await client.query(
    `INSERT INTO scenes (id, project_id, act_id, sequence_id, number, title, duration_seconds, scene_state, continuity_state, content_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, duration_seconds=EXCLUDED.duration_seconds,
       scene_state=EXCLUDED.scene_state, continuity_state=EXCLUDED.continuity_state, content_hash=EXCLUDED.content_hash`,
    [scene.id, projectId, scene.actId, scene.sequenceId, scene.number, scene.title, scene.durationSeconds,
      JSON.stringify(scene), JSON.stringify(scene.shots[0]?.continuity ?? {}), sceneHash],
  );
  await client.query(
    `INSERT INTO scene_versions (scene_id, version, reason, snapshot, affected_region)
     VALUES ($1, 1, 'initial screenplay', $2, $3)
     ON CONFLICT (scene_id, version) DO NOTHING`,
    [scene.id, JSON.stringify(scene), JSON.stringify({ sceneId: scene.id, shots: scene.shots.map((shot) => shot.id) })],
  );
  let cursor = startSeconds;
  for (const shot of scene.shots) {
    const shotHash = contentHash({
      generationPrompt: shot.generationPrompt,
      references: shot.continuity.requiredReferences,
      continuity: shot.continuity,
      dependencies: shot.dependencies,
      audioContext: shot.audioContext,
      durationSeconds: shot.durationSeconds,
    });
    await client.query(
      `INSERT INTO shots (id, project_id, scene_id, sequence, duration_seconds, dependencies, generation_spec, audio_context, continuity_state, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET duration_seconds=EXCLUDED.duration_seconds, dependencies=EXCLUDED.dependencies,
         generation_spec=EXCLUDED.generation_spec, audio_context=EXCLUDED.audio_context,
         continuity_state=EXCLUDED.continuity_state,
         state=CASE WHEN shots.content_hash=EXCLUDED.content_hash AND shots.state<>'cancelled' THEN shots.state ELSE 'planned'::job_state END,
         last_error=CASE WHEN shots.content_hash=EXCLUDED.content_hash THEN shots.last_error ELSE NULL END,
         content_hash=EXCLUDED.content_hash`,
      [shot.id, projectId, scene.id, shot.sequence, shot.durationSeconds, shot.dependencies,
        JSON.stringify(shot), JSON.stringify(shot.audioContext), JSON.stringify(shot.continuity), shotHash],
    );
    const trackMetadata: Array<[string, unknown]> = [
      ["video", { title: shot.title, shotSequence: shot.sequence }],
      ["dialogue", { dialogue: shot.audioContext.dialogue }],
      ["music", { cue: shot.audioContext.musicCue }],
      ["sfx", { effects: shot.audioContext.soundEffects }],
      ["ambience", { ambience: shot.audioContext.ambience, cleanStart: shot.audioContext.cleanStart }],
      ["subtitles", { lines: shot.audioContext.dialogue.map((line) => ({ id: line.id, text: line.text, startSeconds: line.startSeconds, durationSeconds: line.durationSeconds })) }],
    ];
    const activeAsset = await client.query<{ id: string }>(
      `SELECT a.id FROM generation_assets a
       JOIN shot_versions sv ON sv.id=a.shot_version_id AND sv.active=true
       WHERE a.project_id=$1 AND a.shot_id=$2 AND a.kind='video'
       ORDER BY a.created_at DESC LIMIT 1`,
      [projectId, shot.id],
    );
    for (const [track, metadata] of trackMetadata) {
      await client.query(
        `INSERT INTO timeline_clips (project_id,scene_id,shot_id,track,start_seconds,duration_seconds,source_version,metadata,asset_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [projectId, scene.id, shot.id, track, cursor, shot.durationSeconds, planVersion, JSON.stringify(metadata), track === "video" ? activeAsset.rows[0]?.id ?? null : null],
      );
    }
    cursor += shot.durationSeconds;
  }
  return cursor;
}

export async function latestMoviePlan(projectId: string): Promise<MoviePlan | null> {
  const rows = await query<{ plan: MoviePlan }>(
    `SELECT plan FROM movie_plan_versions
     WHERE project_id=$1
     ORDER BY version=(SELECT current_plan_version FROM projects WHERE id=$1) DESC,version DESC
     LIMIT 1`,
    [projectId],
  );
  return rows[0]?.plan ?? null;
}

export async function listProjects(workspaceId: string): Promise<ProjectRecord[]> {
  const rows = await query<{
    id: string; title: string; prompt: string; duration_seconds: number; model_id: string; resolution: string;
      aspect_ratio: string; render_tier: "draft" | "final"; status: ProjectRecord["status"]; progress: string; maximum_budget_usd: string;
    estimated_cost_usd: string; spent_usd: string; completed_shots: number; total_shots: number;
    last_error: ProjectRecord["lastError"]; poster_storage_key: string | null; updated_at: string;
  }>("SELECT * FROM projects WHERE workspace_id = $1 ORDER BY updated_at DESC", [workspaceId]);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    durationSeconds: row.duration_seconds,
    modelId: row.model_id,
    resolution: row.resolution,
      aspectRatio: row.aspect_ratio,
      renderTier: row.render_tier,
    status: row.status,
    progress: Number(row.progress),
    maximumBudgetUsd: Number(row.maximum_budget_usd),
    estimatedCostUsd: Number(row.estimated_cost_usd),
    spentUsd: Number(row.spent_usd),
    completedShots: row.completed_shots,
    totalShots: row.total_shots,
    lastError: row.last_error,
    posterUrl: row.poster_storage_key ?? undefined,
    updatedAt: row.updated_at,
  }));
}

export async function findCachedShot(projectId: string, shotId: string, hash: string): Promise<ShotArtifact | null> {
  const rows = await query<{
    id: string; project_id: string; scene_id: string; shot_id: string; version: number; content_hash: string;
    storage_key: string; mime_type: string; duration_seconds: string; continuity_score: string | null; active: boolean;
  }>(
    `SELECT a.id, a.project_id, a.scene_id, a.shot_id, sv.version, sv.content_hash, a.storage_key,
      a.mime_type, a.duration_seconds, sv.continuity_score, sv.active
     FROM shot_versions sv JOIN generation_assets a ON a.shot_version_id = sv.id
     WHERE a.project_id = $1 AND sv.shot_id = $2 AND sv.content_hash = $3 LIMIT 1`,
    [projectId, shotId, hash],
  );
  const row = rows[0];
  return row ? {
    id: row.id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    shotId: row.shot_id,
    version: row.version,
    contentHash: row.content_hash,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    durationSeconds: Number(row.duration_seconds),
    continuityScore: row.continuity_score ? Number(row.continuity_score) : null,
    active: row.active,
  } : null;
}

export async function latestCheckpoint(projectId: string) {
  const rows = await query<{ snapshot: Record<string, unknown> }>(
    "SELECT snapshot FROM checkpoints WHERE project_id = $1 ORDER BY sequence DESC LIMIT 1",
    [projectId],
  );
  return rows[0]?.snapshot ?? null;
}
