import { NextResponse } from "next/server";
import { query } from "@/server/db";
import { apiError } from "@/server/http";
import { env } from "@/server/env";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (!projectId) return NextResponse.json({ conversations: [] });
    const conversations = await query<{ id: string; title: string; mode: string; last_response_id: string | null; created_at: string }>(
      `SELECT c.id,c.title,c.mode,c.last_response_id,c.created_at FROM conversations c
       JOIN projects p ON p.id=c.project_id
       WHERE c.project_id=$1 AND c.workspace_id=$2 AND p.workspace_id=$2 ORDER BY c.updated_at DESC`,
      [projectId, env().DEFAULT_WORKSPACE_ID],
    );
    const messages = conversations[0]
      ? await query<{ id: string; role: string; content: { text?: string }; response_id: string | null; created_at: string }>(
          "SELECT id,role,content,response_id,created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at",
          [conversations[0].id],
        )
      : [];
    return NextResponse.json({ conversations, messages });
  } catch (error) {
    return apiError(error);
  }
}
