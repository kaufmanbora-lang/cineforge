import type { ProjectContextBundle } from "@/server/providers/openai";
import { query } from "@/server/db";

export async function buildProjectContext(input: {
  projectId?: string;
  selectedSceneId?: string;
}): Promise<ProjectContextBundle> {
  if (!input.projectId) return { durationSeconds: 1_200 };
  const projects = await query<{
    duration_seconds: number; current_plan_version: number; title: string; prompt: string;
  }>("SELECT duration_seconds,current_plan_version,title,prompt FROM projects WHERE id=$1", [input.projectId]);
  if (!projects[0]) return { projectId: input.projectId, durationSeconds: 1_200 };
  const characters = await query<{ id: string; name: string; bible: unknown; current_state: unknown; locks: Record<string, unknown> }>(
    "SELECT id,name,bible,current_state,locks FROM characters WHERE project_id=$1 ORDER BY name",
    [input.projectId],
  );
  const locations = await query<{ id: string; name: string; bible: unknown; current_state: unknown; locks: Record<string, unknown> }>(
    "SELECT id,name,bible,current_state,locks FROM locations WHERE project_id=$1 ORDER BY name",
    [input.projectId],
  );
  const selected = input.selectedSceneId
    ? await query<{ number: number }>("SELECT number FROM scenes WHERE id=$1 AND project_id=$2", [input.selectedSceneId, input.projectId])
    : [];
  const around = selected[0]
    ? await query<{ id: string; number: number; title: string; scene_state: unknown; continuity_state: unknown }>(
        "SELECT id,number,title,scene_state,continuity_state FROM scenes WHERE project_id=$1 AND number BETWEEN $2 AND $3 ORDER BY number",
        [input.projectId, Math.max(1, selected[0].number - 2), selected[0].number + 1],
      )
    : await query<{ id: string; number: number; title: string; scene_state: unknown; continuity_state: unknown }>(
        "SELECT id,number,title,scene_state,continuity_state FROM scenes WHERE project_id=$1 ORDER BY number DESC LIMIT 3",
        [input.projectId],
      );
  const plan = await query<{ plan: { summary?: unknown } }>(
    `SELECT plan FROM movie_plan_versions
     WHERE project_id=$1
     ORDER BY version=(SELECT current_plan_version FROM projects WHERE id=$1) DESC,version DESC
     LIMIT 1`,
    [input.projectId],
  );
  return {
    projectId: input.projectId,
    durationSeconds: projects[0].duration_seconds,
    selectedSceneId: input.selectedSceneId,
    screenplaySummary: JSON.stringify(plan[0]?.plan.summary ?? { title: projects[0].title, prompt: projects[0].prompt }),
    relevantCharacters: characters.map(({ id, name, bible, current_state }) => ({ id, name, bible, currentState: current_state })),
    relevantLocations: locations.map(({ id, name, bible, current_state }) => ({ id, name, bible, currentState: current_state })),
    recentSceneStates: around,
    lockedValues: Object.fromEntries([
      ...characters.map((character) => [`character:${character.id}`, character.locks]),
      ...locations.map((location) => [`location:${location.id}`, location.locks]),
    ]),
  };
}
