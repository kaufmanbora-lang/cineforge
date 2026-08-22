import { NextResponse } from "next/server";

export function apiError(error: unknown, fallbackStatus = 500) {
  const status = typeof error === "object" && error && "status" in error
    ? Number((error as { status: number }).status)
    : fallbackStatus;
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return NextResponse.json({ error: message }, { status: Number.isFinite(status) ? status : fallbackStatus });
}
