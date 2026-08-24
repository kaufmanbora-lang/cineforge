"use client";

import { useEffect, useState } from "react";
import { Bot, CheckCircle2, Database, Eye, EyeOff, KeyRound, LockKeyhole, ServerCog, ShieldCheck, Video } from "lucide-react";
import { Button, StatusDot } from "./ui";
import { errorMessageRu } from "@/lib/ru";

type ProviderState = { configured: boolean; source: "vault" | "environment" | "none"; hint: string | null; status: string; lastCheckedAt: string | null };
type EngineConfig = { qcRetryThreshold: number; qcFlagThreshold: number; automaticRetries: number; workerConcurrency: number; physicalContinuityQc: boolean };
type GoogleBilling = { status: string; balanceUsd: number | null; message?: string; billingUrl: string; usageUrl: string; spendUrl: string };
type StatusPayload = { google: ProviderState & { models?: Array<{ id: string; displayName: string; resolutions: string[]; nativeAudio: boolean; selectable?: boolean; available?: boolean }>; billing?: GoogleBilling; quotaNote?: string }; openai: ProviderState & { taskModels?: Record<string,{ id: string; displayName: string }>; availableModels?: Array<{ id: string; displayName: string }>; routing?: Record<string,string> }; engine: EngineConfig; storage: { bucket: string; region: string; endpoint: string } };

export function SettingsWorkspace() {
  const [section, setSection] = useState("API");
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [googleKey, setGoogleKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [showGoogle, setShowGoogle] = useState(false);
  const [showOpenAI, setShowOpenAI] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState("");
  const [engine, setEngine] = useState<EngineConfig>({ qcRetryThreshold: 75, qcFlagThreshold: 90, automaticRetries: 2, workerConcurrency: 4, physicalContinuityQc: true });

  async function loadStatus() {
    const response = await fetch("/api/settings/status", { cache: "no-store" });
    if (response.ok) { const payload = await response.json(); setStatus(payload); if (payload.engine) setEngine(payload.engine); }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void loadStatus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function save(provider: "google" | "openai") {
    const key = provider === "google" ? googleKey : openaiKey;
    if (!key) return;
    setBusy(provider); setMessage("Проверка подключения…");
    try {
      const response = await fetch(`/api/settings/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(errorMessageRu(payload.error, "Не удалось проверить подключение."));
      if (provider === "google") setGoogleKey("");
      else setOpenaiKey("");
      setMessage(provider === "google" ? "Ключ Google действителен, каталог видеомоделей доступен. Баланс Google проверяется отдельно в AI Studio." : "Ключ OpenAI проверен и безопасно сохранён на сервере.");
      await loadStatus();
    } catch (error) { setMessage(errorMessageRu(error, "Не удалось проверить подключение.")); }
    finally { setBusy(undefined); }
  }

  async function test(provider: "google" | "openai") {
    setBusy(`test-${provider}`); setMessage("Проверка подключения…");
    try {
      const response = await fetch(`/api/settings/${provider}`, { method: "PUT" });
      const payload = await response.json();
      if (!response.ok) throw new Error(errorMessageRu(payload.error, "Не удалось проверить подключение."));
      setMessage(provider === "google" ? "Ключ Google действителен, доступные модели обновлены. Остаток денег Google не передаёт через API." : "Подключение OpenAI работает."); await loadStatus();
    } catch (error) { setMessage(errorMessageRu(error, "Не удалось проверить подключение.")); }
    finally { setBusy(undefined); }
  }

  async function saveRouting(task: string, modelId: string) {
    setBusy(`routing-${task}`); setMessage("Сохранение модели для задачи…");
    try {
      const response = await fetch("/api/settings/openai", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task, modelId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(errorMessageRu(payload.error, "Не удалось сохранить выбор модели."));
      setMessage(`Для задачи «${taskLabel(task)}» выбрана модель ${modelId}.`); await loadStatus();
    } catch (error) { setMessage(errorMessageRu(error, "Не удалось сохранить выбор модели.")); }
    finally { setBusy(undefined); }
  }

  async function saveEngine() {
    setBusy("engine"); setMessage("Сохранение лимитов киносистемы…");
    try {
      const response = await fetch("/api/settings/status", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(engine) });
      const payload = await response.json(); if (!response.ok) throw new Error(errorMessageRu(payload.error, "Не удалось сохранить настройки киносистемы."));
      setMessage("Лимиты киносистемы сохранены. Проверка качества и новые повторы применяют их сразу; параллельность — после перезапуска фонового обработчика."); await loadStatus();
    } catch (error) { setMessage(errorMessageRu(error, "Не удалось сохранить настройки киносистемы.")); }
    finally { setBusy(undefined); }
  }

  return <div className="page-frame">
    <div className="page-heading"><div><h1>Настройки</h1><p>API-ключи, ИИ-модели, хранилище и производственные лимиты.</p></div>{message ? <div className="secure-note"><CheckCircle2 size={14} />{message}</div> : null}</div>
    <div className="settings-layout">
      <nav className="settings-nav">{[{label:"API",icon:KeyRound},{label:"ИИ-модели",icon:Bot},{label:"Киносистема",icon:ServerCog},{label:"Хранилище",icon:Database},{label:"Безопасность",icon:ShieldCheck}].map(({label,icon:Icon}) => <button className={section === label ? "active" : ""} key={label} onClick={() => setSection(label)} type="button"><Icon size={14} />{label}</button>)}</nav>
      <div className="settings-content">
        {section === "API" ? <>
          <ProviderCard icon={<Video size={16} />} name="Google Gemini / Video API" description="Veo 3.1, Gemini Omni Flash и другие официально доступные видеомодели Google" provider={status?.google}>
            <div className="form-row"><label htmlFor="google-key">API-ключ</label><div><div className="field-group"><input autoComplete="off" id="google-key" onChange={(event) => setGoogleKey(event.target.value)} placeholder={status?.google.hint || "Введите GEMINI_API_KEY"} type={showGoogle ? "text" : "password"} value={googleKey} /><Button aria-label={showGoogle ? "Скрыть ключ" : "Показать ключ"} onClick={() => setShowGoogle((value) => !value)}>{showGoogle ? <EyeOff size={14} /> : <Eye size={14} />}</Button><Button disabled={!googleKey.trim()} loading={busy === "google"} onClick={() => save("google")} variant="primary">Сохранить и проверить</Button></div><p className="field-help">После сохранения поле очищается. Полный ключ никогда не возвращается в браузер.</p></div></div>
            <div className="form-row"><label>Подключение</label><div><Button loading={busy === "test-google"} onClick={() => test("google")}>Проверить ключ и модели</Button><p className="field-help">{status?.google.quotaNote ?? "Google не предоставляет остаток баланса через API."}</p><div className="page-actions" style={{ justifyContent: "flex-start", marginTop: 8 }}><a className="button button-teal" href={status?.google.billing?.billingUrl ?? "https://aistudio.google.com/billing"} rel="noreferrer" target="_blank">Баланс и Prepay</a><a className="button" href={status?.google.billing?.usageUrl ?? "https://aistudio.google.com/usage"} rel="noreferrer" target="_blank">Использование</a><a className="button" href={status?.google.billing?.spendUrl ?? "https://aistudio.google.com/spend"} rel="noreferrer" target="_blank">Лимит расходов</a></div></div></div>
            <ModelTable models={status?.google.models ?? []} />
          </ProviderCard>
          <ProviderCard icon={<Bot size={16} />} name="OpenAI Responses API" description="ChatGPT-сценарист, инженер промптов и ИИ-режиссёр" provider={status?.openai}>
            <div className="form-row"><label htmlFor="openai-key">API-ключ</label><div><div className="field-group"><input autoComplete="off" id="openai-key" onChange={(event) => setOpenaiKey(event.target.value)} placeholder={status?.openai.hint || "Введите OPENAI_API_KEY"} type={showOpenAI ? "text" : "password"} value={openaiKey} /><Button aria-label={showOpenAI ? "Скрыть ключ" : "Показать ключ"} onClick={() => setShowOpenAI((value) => !value)}>{showOpenAI ? <EyeOff size={14} /> : <Eye size={14} />}</Button><Button disabled={!openaiKey.trim()} loading={busy === "openai"} onClick={() => save("openai")} variant="primary">Сохранить и проверить</Button></div><p className="field-help">Ключ хранится только на сервере и шифруется с помощью AES-256-GCM.</p></div></div>
            <div className="form-row"><label>Подключение</label><div><Button loading={busy === "test-openai"} onClick={() => test("openai")}>Проверить подключение</Button></div></div>
          </ProviderCard>
          <div className="secure-note"><LockKeyhole size={15} />Секреты используются только серверными маршрутами и фоновым обработчиком. Ключи не попадают в React, ответы API или клиентский JavaScript.</div>
        </> : null}
        {section === "ИИ-модели" ? <ModelRouting available={status?.openai.availableModels ?? []} busy={busy} onChange={saveRouting} routing={status?.openai.routing ?? {}} /> : null}
        {section === "Киносистема" ? <EngineSettings busy={busy === "engine"} config={engine} onChange={setEngine} onSave={saveEngine} /> : null}
        {section === "Хранилище" ? <InfoCard title="Объектное хранилище"><p>Видео, звук, референсные кадры и экспорты хранятся в S3-совместимом объектном хранилище. В PostgreSQL находятся только метаданные и ключи объектов.</p><div className="readout-list"><p><strong>Контейнер</strong><span>{status?.storage.bucket ?? "Загрузка…"}</span></p><p><strong>Регион</strong><span>{status?.storage.region ?? "Загрузка…"}</span></p><p><strong>Адрес</strong><span>{status?.storage.endpoint ?? "Загрузка…"}</span></p></div><p className="field-help">Данные доступа к хранилищу являются секретами развёртывания и не редактируются в браузере.</p></InfoCard> : null}
        {section === "Безопасность" ? <InfoCard title="Политика безопасности"><div className="memory-facts"><p><CheckCircle2 size={13} />Зашифрованные ключи провайдеров</p><p><CheckCircle2 size={13} />Подписанные временные ссылки на файлы</p><p><CheckCircle2 size={13} />Проверка входных данных</p><p><CheckCircle2 size={13} />Подтверждение бюджета до платной генерации</p></div></InfoCard> : null}
      </div>
    </div>
  </div>;
}

function ProviderCard({ icon, name, description, provider, children }: { icon: React.ReactNode; name: string; description: string; provider?: ProviderState; children: React.ReactNode }) { const connected = provider?.configured && provider.status !== "failed"; const source = provider?.source === "vault" ? "зашифрованное хранилище" : "серверная переменная"; return <section className="settings-card"><header className="settings-card-head"><span className="provider-mark">{icon}</span><div><h2>{name}</h2><p>{description}</p></div><span className="connection"><StatusDot tone={connected ? "green" : "red"} />{connected ? `Ключ сохранён: ${source}` : "Не подключён"}</span></header><div className="settings-card-body">{children}</div></section>; }
function ModelTable({ models }: { models: Array<{ id: string; displayName: string; resolutions: string[]; nativeAudio: boolean; selectable?: boolean; available?: boolean }> }) { return <table className="model-table"><thead><tr><th>Видеомодель</th><th>Разрешение</th><th>Звук</th><th>Доступ ключа</th></tr></thead><tbody>{models.map((model) => <tr key={model.id}><td><strong>{model.displayName}</strong><br/><span style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 8 }}>{model.id}</span></td><td>{model.resolutions.length ? model.resolutions.join(" · ") : "Не проверено"}</td><td>{model.nativeAudio ? "Встроенный" : model.selectable === false ? "Не проверено" : "Отдельный"}</td><td><StatusDot tone={model.available ? "green" : model.selectable === false ? "amber" : "red"} /> {model.available ? "Видна проекту" : model.selectable === false ? "Найдена без адаптера" : "Недоступна"}</td></tr>)}</tbody></table>; }
function ModelRouting({ available, routing, busy, onChange }: { available: Array<{ id: string; displayName: string }>; routing: Record<string,string>; busy?: string; onChange: (task: string, modelId: string) => Promise<void> }) { return <InfoCard title="Распределение задач OpenAI"><p>Сильная модель используется для архитектуры истории; более быстрые модели — для промптов и массовой проверки качества. Выбор хранится отдельно для этой студии и применяется только на сервере.</p>{["screenwriting","prompts","qc"].map((task) => <div className="form-row" key={task}><label>{taskLabel(task)}</label><div className="field-group"><select className="settings-select" disabled={!available.length || busy === `routing-${task}`} onChange={(event) => void onChange(task,event.target.value)} value={routing[task] ?? available[0]?.id ?? ""}>{!available.length ? <option value="">Подключите OpenAI для загрузки моделей</option> : null}{available.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.id}</option>)}</select></div></div>)}</InfoCard>; }
function EngineSettings({ config, busy, onChange, onSave }: { config: EngineConfig; busy: boolean; onChange: (value: EngineConfig) => void; onSave: () => Promise<void> }) { const numberField = (key: Exclude<keyof EngineConfig,"physicalContinuityQc">, min: number, max: number) => ({ min, max, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...config, [key]: Math.max(min, Math.min(max, Number(event.target.value) || min)) }), value: config[key] }); return <InfoCard title="Киносистема"><p>Эти лимиты управляют автоматическими повторами и решениями контроля качества. Ошибка одного кадра никогда не отменяет готовые контрольные точки.</p><div className="form-row"><label>Повторять при оценке ниже</label><input className="settings-select" type="number" {...numberField("qcRetryThreshold",0,100)}/></div><div className="form-row"><label>Помечать при оценке ниже</label><input className="settings-select" type="number" {...numberField("qcFlagThreshold",0,100)}/></div><div className="form-row"><label>Автоматические повторы</label><input className="settings-select" type="number" {...numberField("automaticRetries",0,5)}/></div><div className="form-row"><label>Параллельных заданий</label><div><input className="settings-select" type="number" {...numberField("workerConcurrency",1,16)}/><p className="field-help">Применится после следующего запуска фонового обработчика.</p></div></div><div className="form-row"><label>Физика и переходы</label><div><label className="toggle-row"><span>Проверять даже быстрый черновик</span><button aria-pressed={config.physicalContinuityQc} className={config.physicalContinuityQc ? "toggle on" : "toggle"} onClick={() => onChange({ ...config, physicalContinuityQc: !config.physicalContinuityQc })} type="button"><i/></button></label><p className="field-help">ИИ сравнивает финал прошлого кадра с началом, серединой и концом нового. При явной телепортации, смене места или исчезновении объекта повторяется только плохой кадр.</p></div></div><Button loading={busy} onClick={() => void onSave()} variant="primary">Сохранить настройки киносистемы</Button></InfoCard>; }
function InfoCard({ title, children }: { title: string; children: React.ReactNode }) { return <section className="settings-card"><header className="settings-card-head"><h2>{title}</h2></header><div className="settings-card-body" style={{ color: "var(--muted)", fontSize: 10, lineHeight: 1.6 }}>{children}</div></section>; }
function taskLabel(task: string) { return ({ screenwriting: "Сценарий", prompts: "Промпты", qc: "Контроль качества" } as Record<string,string>)[task] ?? task; }
