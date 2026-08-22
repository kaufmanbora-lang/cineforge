import { NextResponse } from "next/server";
import { query } from "@/server/db";
import { apiError } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (!projectId) return NextResponse.json({ conversations: [] });
    const conversations = await query<{ id: string; title: string; mode: string; last_response_id: string | null; created_at: string }>(
      "SELECT id,title,mode,last_response_id,created_at FROM conversations WHERE project_id=$1 ORDER BY updated_at DESC",
      [projectId],
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
