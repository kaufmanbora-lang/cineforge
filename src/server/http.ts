import { NextResponse } from "next/server";
import { errorMessageRu } from "@/lib/ru";

export function apiError(error: unknown, fallbackStatus = 500) {
  const status = typeof error === "object" && error && "status" in error
    ? Number((error as { status: number }).status)
    : fallbackStatus;
  const message = errorMessageRu(error, "Внутренняя ошибка сервера.");
  return NextResponse.json({ error: message }, { status: Number.isFinite(status) ? status : fallbackStatus });
}
