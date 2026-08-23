import type { JobState, ProjectStatus } from "@/domain/movie";

export const PROJECT_STATUS_RU: Record<ProjectStatus, string> = {
  draft: "Черновик",
  planning: "Создание сценария",
  planned: "Спланирован",
  queued: "В очереди",
  generating: "Генерация",
  validating: "Проверка качества",
  assembling: "Монтаж",
  completed: "Готов",
  paused: "Приостановлен",
  failed: "Ошибка",
  cancelled: "Отменён",
};

export const JOB_STATE_RU: Record<JobState, string> = {
  planned: "Запланировано",
  queued: "В очереди",
  generating: "Генерация",
  validating: "Проверка",
  retrying: "Повторная попытка",
  completed: "Готово",
  paused: "Приостановлено",
  failed: "Ошибка",
  cancelled: "Отменено",
};

const LOCK_LABELS: Record<string, string> = {
  appearance: "Внешность",
  voice: "Голос",
  outfit: "Одежда",
  design: "Дизайн",
};

export function projectStatusRu(status: ProjectStatus | string | undefined): string {
  return status && status in PROJECT_STATUS_RU ? PROJECT_STATUS_RU[status as ProjectStatus] : "Неизвестно";
}

export function lockLabelRu(value: string): string {
  return LOCK_LABELS[value] ?? value;
}

export function errorMessageRu(value: unknown, fallback = "Операция не выполнена."): string {
  const message = value instanceof Error ? value.message : String(value ?? "");
  if (!message) return fallback;
  if (/[А-Яа-яЁё]/.test(message)) return message;
  const rules: Array<[RegExp, string]> = [
    [/project (infrastructure|memory|storage).*offline|infrastructure is offline/i, "Облачная инфраструктура проекта временно недоступна."],
    [/project not found/i, "Проект не найден."],
    [/openai.*not configured|openai_api_key/i, "Ключ OpenAI не настроен."],
    [/google.*not configured|gemini_api_key/i, "Ключ Google Gemini не настроен."],
    [/invalid.*api.?key|unauthenticated|authentication/i, "API-ключ недействителен или отозван."],
    [/quota|resource_exhausted/i, "Квота или доступный лимит API исчерпаны. Проект сохранён и поставлен на паузу."],
    [/rate.?limit|too many requests/i, "Сервис временно ограничил частоту запросов. Повтор будет выполнен с задержкой."],
    [/prepay(?:ment|paid)?.*(?:depleted|exhausted|unavailable)|no (?:available )?(?:prepay )?credits|billing.*(?:inactive|not active|not enabled|unsupported)|payment required|credit balance.*(?:zero|depleted|exhausted)/i, "Google сообщил, что Prepay недоступен для проекта этого ключа. Готовые кадры сохранены; проверьте Paid/Prepay в Google AI Studio и продолжите с контрольной точки."],
    [/permission|forbidden|access restricted/i, "У проекта нет доступа к выбранной модели или региону."],
    [/model.*not found|unsupported video model/i, "Выбранная модель недоступна. Выберите другую модель в настройках проекта."],
    [/timeout|deadline/i, "Сервис не ответил вовремя. Попробуйте ещё раз."],
    [/moderation|safety|blocked/i, "Запрос отклонён правилами безопасности провайдера."],
    [/network|fetch failed|econnreset/i, "Ошибка сети при обращении к облачному сервису."],
    [/estimated generation exceeds.*budget|maximum generation budget/i, "Расчётная стоимость превышает максимальный бюджет проекта."],
    [/plan the movie before/i, "Сначала создайте сценарий и план фильма."],
    [/no structured movieplan|no structured/i, "AI-сценарист не вернул корректный структурированный сценарий."],
    [/object schema.*additionalproperties/i, "Сценарный сервис вернул несовместимую структуру данных."],
    [/connection failed/i, "Не удалось проверить подключение."],
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? fallback;
}

export function dateTimeRu(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
