"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Aperture, Check, Clapperboard, Expand, Eye, Film, Gauge,
  ImageIcon, Lightbulb, ListVideo, Lock, MessageSquareText, Music2, Play,
  Mic, Sparkles, Square, Subtitles, Volume2, Waves, X, Zap, ZoomIn, ZoomOut,
} from "lucide-react";
import { estimateGeneration, formatDuration } from "@/domain/estimation";
import type { MoviePlan, ProjectRecord, Scene } from "@/domain/movie";
import { GOOGLE_VIDEO_MODELS, isNativeResolution, normalizeResolution, type AspectRatio, type Resolution } from "@/domain/video-models";
import { Button, Segmented, StatusDot } from "./ui";
import { errorMessageRu, lockLabelRu, projectStatusRu } from "@/lib/ru";

type JobRow = { id: string; type: string; state: string; scene_id: string | null; shot_id: string | null; last_error: unknown };
type CheckpointRow = { sequence: string; event_type: string; completed_shot_ids: string[]; failed_shot_ids: string[]; pending_shot_ids: string[]; created_at: string };
type DetailPayload = { project: ProjectRecord; plan: MoviePlan | null; jobs: JobRow[]; checkpoints: CheckpointRow[] };
type PreviewClip = { shot_id: string; scene_id: string; url: string; version: number; continuity_score: string | null };
type PreviewPayload = { clips: PreviewClip[]; movieUrl: string | null };
type Track = { label: string; icon: typeof Film; tone: string; clips: Array<{ id: string; sceneId: string; label: string; duration: number }> };

export function StudioWorkspace() {
  const [mode, setMode] = useState<"quick" | "advanced">("quick");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(10);
  const [customDuration, setCustomDuration] = useState(false);
  const [modelId, setModelId] = useState("gemini-omni-flash-preview");
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [draft, setDraft] = useState(true);
  const [budget, setBudget] = useState(25);
  const [projectId, setProjectId] = useState("");
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [preview, setPreview] = useState<PreviewPayload>({ clips: [], movieUrl: null });
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [selectedShotId, setSelectedShotId] = useState("");
  const [rightTab, setRightTab] = useState<"overview" | "scenes" | "memory">("overview");
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [busy, setBusy] = useState<"planning" | "generating" | null>(null);
  const [notice, setNotice] = useState("Опишите идею фильма, чтобы начать.");
  const [accountModelIds, setAccountModelIds] = useState<Set<string> | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(100);
  const [voiceState, setVoiceState] = useState<"recording" | "transcribing" | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const autoContinueRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);

  const model = GOOGLE_VIDEO_MODELS[modelId];
  const estimate = useMemo(() => estimateGeneration({ durationSeconds: duration, modelId, resolution }), [duration, modelId, resolution]);
  const plan = detail?.plan;
  const scenes = plan?.scenes ?? [];
  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? scenes[0];
  const selectedPreview = preview.clips.find((clip) => clip.shot_id === selectedShotId && clip.scene_id === selectedScene?.id)
    ?? preview.clips.find((clip) => clip.scene_id === selectedScene?.id)
    ?? null;
  const activeJobs = detail?.jobs.filter((job) => ["queued","generating","validating","retrying"].includes(job.state)) ?? [];
  const latestCheckpoint = detail?.checkpoints[0];
  const progress = detail?.project.progress ?? 0;

  const loadProject = useCallback(async (id: string, quiet = false) => {
    if (!id) return;
    try {
      const [detailResponse, previewResponse] = await Promise.all([
        fetch(`/api/projects?id=${encodeURIComponent(id)}`, { cache: "no-store" }),
        fetch(`/api/projects/${id}/preview`, { cache: "no-store" }),
      ]);
      const payload = await detailResponse.json();
      if (!detailResponse.ok || payload.infrastructure === "offline") throw new Error(errorMessageRu(payload.error, "Облачная инфраструктура проекта недоступна."));
      setDetail(payload); setProjectId(id); localStorage.setItem("cineforge.projectId", id);
      setPrompt(payload.project.prompt); setDuration(payload.project.durationSeconds); setModelId(payload.project.modelId);
      setResolution(payload.project.resolution); setAspectRatio(payload.project.aspectRatio); setBudget(Number(payload.project.maximumBudgetUsd));
      setDraft(payload.project.renderTier !== "final");
      setSelectedSceneId((current) => current && payload.plan?.scenes.some((scene: Scene) => scene.id === current) ? current : payload.plan?.scenes?.[0]?.id ?? "");
      if (previewResponse.ok) {
        const nextPreview = await previewResponse.json() as PreviewPayload;
        setPreview(nextPreview);
        setSelectedShotId((current) => nextPreview.clips.some((clip) => clip.shot_id === current) ? current : nextPreview.clips[0]?.shot_id ?? "");
      }
      if (payload.project.lastError?.message) {
        setNotice(errorMessageRu(payload.project.lastError.message, "Проект остановлен с ошибкой. Можно безопасно повторить действие."));
      } else if (payload.project.status === "planning") {
        setNotice("Проект сохранён. ИИ-сценарист создаёт сценарий и память в фоновой очереди — окно можно закрыть.");
      } else if (["queued","generating","validating","assembling"].includes(payload.project.status)) {
        setNotice(`Производство работает: готово ${payload.project.completedShots} из ${payload.project.totalShots} кадров.`);
      } else if (!quiet) {
        setNotice(payload.plan ? `Из памяти проекта загружено сцен: ${payload.plan.scenes.length}.` : "У проекта ещё нет сценария. Можно повторить планирование без создания копии.");
      }
    } catch (error) { if (!quiet) setNotice(errorMessageRu(error, "Не удалось загрузить проект.")); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const preparedRaw = sessionStorage.getItem("cineforge.preparedProject");
      const queryId = new URL(window.location.href).searchParams.get("project");
      let prepared: { projectId?: string; durationSeconds: number; modelId: string; resolution: Resolution; shots: number } | null = null;
      if (preparedRaw) try { prepared = JSON.parse(preparedRaw); } catch { sessionStorage.removeItem("cineforge.preparedProject"); }
      const existingId = queryId ?? prepared?.projectId ?? null;
      if (prepared && GOOGLE_VIDEO_MODELS[prepared.modelId]) {
        setDuration(prepared.durationSeconds); setModelId(prepared.modelId); setResolution(normalizeResolution(prepared.modelId, prepared.resolution)); setBudgetOpen(Boolean(existingId));
        setNotice(`ИИ-сценарист подготовил кадров: ${prepared.shots}.`);
      }
      if (existingId) await loadProject(existingId);
      try {
        const response = await fetch("/api/models/google", { cache: "no-store" }); const payload = await response.json();
        if (!payload.connected) { setAccountModelIds(new Set()); setNotice((current) => existingId ? current : "Подключите Google API в настройках перед генерацией видео."); return; }
        const available = new Set<string>((payload.models ?? []).filter((entry: { available?: boolean; selectable?: boolean }) => entry.available && entry.selectable !== false).map((entry: { id: string }) => entry.id));
        setAccountModelIds(available);
        if (available.size) setModelId((current) => { if (available.has(current)) return current; const next = [...available][0]; setResolution((value) => normalizeResolution(next, value)); return next; });
        else setNotice("Для этого Google-проекта не включена ни одна поддерживаемая видеомодель.");
      } catch { setAccountModelIds(new Set()); setNotice("Не удалось проверить доступ к видеомоделям Google."); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadProject]);

  useEffect(() => {
    if (!projectId || !detail || ["draft","planned","completed","paused","failed","cancelled"].includes(detail.project.status)) return;
    const interval = window.setInterval(() => void loadProject(projectId, true), 2_500);
    return () => window.clearInterval(interval);
  }, [detail, loadProject, projectId]);

  useEffect(() => {
    if (!autoContinueRef.current || !selectedPreview) return;
    autoContinueRef.current = false;
    void videoRef.current?.play().catch(() => setNotice("Следующий кадр выбран. Нажмите воспроизведение, если браузер заблокировал автозапуск."));
  }, [selectedPreview]);

  function changeModel(nextId: string) { setModelId(nextId); setResolution((current) => normalizeResolution(nextId, current)); }
  function startNewProject() {
    setProjectId(""); setDetail(null); setPreview({ clips: [], movieUrl: null }); setSelectedSceneId(""); setSelectedShotId(""); setPrompt(""); setBudgetOpen(false);
    localStorage.removeItem("cineforge.projectId"); sessionStorage.removeItem("cineforge.preparedProject"); setNotice("Опишите идею нового фильма.");
  }

  function openProductionConfirmation() {
    if (prompt.trim().length < 10) { setNotice("Описание фильма должно содержать не менее 10 символов."); return; }
    if (accountModelIds && !accountModelIds.has(modelId)) { setNotice("Выбранная видеомодель Google недоступна этому API-ключу."); return; }
    setBudgetOpen(true);
  }

  async function toggleVoiceInput() {
    if (voiceState === "recording" && recorderRef.current) {
      setNotice("Распознаю запись и добавляю текст…");
      setVoiceState("transcribing");
      recorderRef.current.stop();
      return;
    }
    if (voiceState || plan) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("На этом устройстве запись с микрофона не поддерживается.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      microphoneStreamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: BlobPart[] = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
        microphoneStreamRef.current = null;
        try {
          const audio = new Blob(chunks, { type: mimeType });
          if (audio.size < 500) throw new Error("Запись получилась пустой. Нажмите микрофон и произнесите описание фильма.");
          const form = new FormData();
          form.append("audio", audio, "movie-description.webm");
          const response = await fetch("/api/screenwriter/chat?transcribe=1", {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(90_000),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(errorMessageRu(payload.error, "Не удалось распознать голос."));
          const transcript = String(payload.text ?? "").trim();
          if (!transcript) throw new Error("Речь не распознана. Попробуйте говорить ближе к микрофону.");
          setPrompt((current) => `${current.trim()}${current.trim() ? " " : ""}${transcript}`);
          setNotice("Голос распознан и добавлен в описание фильма.");
        } catch (error) {
          setNotice(errorMessageRu(error, "Не удалось распознать голос."));
        } finally {
          recorderRef.current = null;
          setVoiceState(null);
        }
      };
      recorder.start(250);
      setVoiceState("recording");
      setNotice("Запись идёт. Говорите, затем ещё раз нажмите красный микрофон.");
    } catch (error) {
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      microphoneStreamRef.current = null;
      recorderRef.current = null;
      setVoiceState(null);
      setNotice(errorMessageRu(error, "Не удалось включить микрофон. Разрешите доступ к нему и повторите."));
    }
  }

  async function startFullProduction() {
    if (prompt.trim().length < 10) { setNotice("Описание фильма должно содержать не менее 10 символов."); return; }
    if (accountModelIds && !accountModelIds.has(modelId)) { setNotice("Выбранная видеомодель Google недоступна этому API-ключу."); return; }
    setBudgetOpen(false); setBusy("generating"); setNotice("Сохраняю проект и ставлю полный цикл в фоновую очередь…");
    let activeProjectId = projectId && detail ? projectId : "";
    try {
      if (!activeProjectId) {
        const created = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Фильм без названия", prompt, durationSeconds: duration, modelId, resolution, aspectRatio, mode, renderTier: draft ? "draft" : "final", maximumBudgetUsd: budget }), signal: AbortSignal.timeout(30_000) });
        const createdPayload = await created.json(); if (!created.ok) throw new Error(errorMessageRu(createdPayload.error, "Не удалось создать проект."));
        activeProjectId = createdPayload.projectId as string; setProjectId(activeProjectId); localStorage.setItem("cineforge.projectId", activeProjectId);
      }
      const response = await fetch(`/api/projects/${activeProjectId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startGeneration: true, confirmed: true, maximumBudgetUsd: budget }),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json(); if (!response.ok) throw new Error(errorMessageRu(payload.error, "Не удалось запустить полный цикл создания фильма."));
      setNotice(payload.accepted
        ? `Проект сохранён. В фоне создаётся сценарий; затем автоматически запустятся ${payload.shots} кадров.`
        : `Производство запущено: ${payload.shots} кадров. Быстрый черновик появится в предпросмотре автоматически.`);
      await loadProject(activeProjectId, true);
    } catch (error) { if (activeProjectId) await loadProject(activeProjectId, true); setNotice(errorMessageRu(error, "Запуск завершился ошибкой. Проект сохранён; повторная попытка продолжит его без копии.")); }
    finally { setBusy(null); }
  }

  function selectRelative(offset: number) { const index = scenes.findIndex((scene) => scene.id === selectedScene?.id); const next = scenes[Math.max(0, Math.min(scenes.length - 1, index + offset))]; if (next) { setSelectedSceneId(next.id); setSelectedShotId(preview.clips.find((clip) => clip.scene_id === next.id)?.shot_id ?? ""); } }
  function continuePreview() {
    if (!selectedPreview) return;
    const index = preview.clips.findIndex((clip) => clip.shot_id === selectedPreview.shot_id);
    const next = preview.clips[index + 1];
    if (!next) return;
    autoContinueRef.current = true;
    setSelectedSceneId(next.scene_id);
    setSelectedShotId(next.shot_id);
  }
  async function togglePreview() { if (!videoRef.current) return; if (videoRef.current.paused) await videoRef.current.play(); else videoRef.current.pause(); }
  async function openFullscreen() { const node = videoRef.current?.parentElement; if (node?.requestFullscreen) await node.requestFullscreen(); }

  const tracks = buildTracks(scenes);
  const costOverBudget = estimate.estimatedTotalUsd > budget;
  const productionActive = Boolean(detail && ["planning","queued","generating","validating","assembling"].includes(detail.project.status));
  const productionComplete = detail?.project.status === "completed";

  return <div className="studio-grid">
    <section className="brief-panel" aria-label="Описание фильма">
      <div className="section-title"><h1>{plan ? detail?.project.title : "Опишите ваш фильм"}</h1>{plan ? <Button onClick={startNewProject} variant="ghost">Новый проект</Button> : null}</div>
      {plan ? <div className="secure-note"><StatusDot tone="green"/>Структурированный план фильма сохранён. Точечно изменить сценарий можно через ИИ-сценариста.</div> : <Segmented value={mode} onChange={setMode} options={[{ value: "quick", label: "Быстро" }, { value: "advanced", label: "Расширенно" }]}/>}
      <div className="prompt-box"><textarea aria-label="Описание фильма" disabled={Boolean(plan)} maxLength={20_000} onChange={(event) => setPrompt(event.target.value)} placeholder="Опишите историю, персонажей, место действия и желаемое настроение…" value={prompt}/><button aria-label={voiceState === "recording" ? "Остановить запись голоса" : "Продиктовать описание фильма"} className={`voice-input ${voiceState ?? ""}`} disabled={Boolean(plan) || voiceState === "transcribing"} onClick={() => void toggleVoiceInput()} title={voiceState === "recording" ? "Остановить и распознать" : "Надиктовать описание"} type="button"><Mic size={16}/></button><span>{voiceState === "recording" ? "Идёт запись…" : voiceState === "transcribing" ? "Распознаю…" : `${prompt.length} / 20 000`}</span></div>
      <div className="control-stack">
        <label><span><Aperture size={15}/>Продолжительность</span><select disabled={Boolean(plan)} onChange={(event) => { if (event.target.value === "custom") setCustomDuration(true); else { setCustomDuration(false); setDuration(Number(event.target.value)); } }} value={customDuration ? "custom" : duration}>{[10,30,60,180,300,600,900,1200,1800,2700,3600].map((seconds) => <option key={seconds} value={seconds}>{formatDuration(seconds)}</option>)}<option value="custom">Своя продолжительность…</option></select></label>
        {customDuration ? <label><span>Секунды</span><input aria-label="Продолжительность в секундах" max="3600" min="1" onChange={(event) => setDuration(Math.max(1, Math.min(3600, Number(event.target.value) || 1)))} type="number" value={duration}/></label> : null}
        <label><span><Sparkles size={15}/>Модель</span><select disabled={Boolean(plan)} onChange={(event) => changeModel(event.target.value)} value={modelId}>{Object.values(GOOGLE_VIDEO_MODELS).map((entry) => <option disabled={accountModelIds !== null && !accountModelIds.has(entry.id)} key={entry.id} value={entry.id}>{entry.displayName}{accountModelIds !== null && !accountModelIds.has(entry.id) ? " · недоступна" : ""}</option>)}</select></label>
        <div className="split-control"><label><span><ImageIcon size={15}/>Разрешение</span><select disabled={Boolean(plan)} onChange={(event) => setResolution(event.target.value as Resolution)} value={resolution}>{model.resolutions.map((entry) => <option key={entry} value={entry}>{resolutionOptionLabel(modelId, entry)}</option>)}</select></label><label className="aspect"><span>Формат</span><select disabled={Boolean(plan)} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)} value={aspectRatio}>{model.aspectRatios.map((entry) => <option key={entry}>{entry}</option>)}</select></label></div>
        <label className="toggle-row"><span><Zap size={15}/>Быстрый черновик</span><button aria-pressed={draft} className={draft ? "toggle on" : "toggle"} disabled={Boolean(plan)} onClick={() => setDraft((value) => !value)} type="button"><i/></button></label>
      </div>
      <div className="estimate-lines"><div><span>Примерно кадров</span><strong>{estimate.shots}</strong></div><div><span>Генерация видео</span><strong>${estimate.videoUsd.toFixed(2)}</strong></div><div><span>Звук</span><strong>${estimate.audioUsd.toFixed(2)}</strong></div><div><span>Резерв на повторы</span><strong>${estimate.retriesReserveUsd.toFixed(2)}</strong></div><div className="budget-line"><span>Максимальный бюджет</span><label>$<input aria-label="Максимальный бюджет генерации" min="0" onChange={(event) => setBudget(Math.max(0, Number(event.target.value) || 0))} type="number" value={budget}/></label></div></div>
      <Button className="plan-button" disabled={prompt.trim().length < 10 || busy !== null || productionActive || productionComplete} loading={busy !== null} onClick={openProductionConfirmation} variant="primary">{productionComplete ? "Фильм готов" : detail?.project.status === "planning" ? "Сценарий создаётся в фоне" : productionActive ? "Производство запущено" : detail?.project.status === "paused" ? "Продолжить с остановленного кадра" : detail?.project.status === "failed" ? "Повторить без потери готовых кадров" : plan ? "Продолжить и создать фильм" : "Создать фильм"}<Clapperboard size={16}/></Button>
      <div className={`production-notice ${detail?.project.status === "paused" || detail?.project.status === "failed" ? "warning" : productionActive ? "active" : ""}`} role="status"><StatusDot tone={detail?.project.status === "failed" ? "red" : detail?.project.status === "paused" ? "amber" : productionActive ? "teal" : "green"}/><span>{notice}</span></div>
      <p className="approx-note">Одно подтверждение запускает весь цикл. Быстрый черновик использует ускоренную модель и публикует кадры сразу после ответа Google.</p>
    </section>

    <section className="preview-panel" aria-label="Предпросмотр фильма">
      <div className="preview-frame">{selectedPreview ? <video controls key={selectedPreview.url} onEnded={continuePreview} ref={videoRef} src={selectedPreview.url}/> : <div className="preview-empty"><Film size={36}/><strong>{selectedScene ? "Кадр ещё не создан" : "Сцена не выбрана"}</strong><span>{selectedScene ? "Видео появится после успешной контрольной точки." : "Создайте план фильма, чтобы построить граф сцен."}</span></div>}{selectedScene ? <div className="preview-corner"><span>СЦЕНА {selectedScene.number}</span><strong>{selectedScene.title}</strong></div> : null}</div>
      <div className="transport"><strong>{selectedScene ? formatTimecode(sceneStart(scenes, selectedScene.id)) : "00:00:00"}</strong><span className="fit-control">{selectedPreview ? `Кадр ${selectedPreview.shot_id} · v${selectedPreview.version}` : "Нет видео"}</span><div className="transport-center"><button aria-label="Предыдущая сцена" disabled={!selectedScene || scenes[0]?.id === selectedScene.id} onClick={() => selectRelative(-1)} type="button"><Play size={17} style={{ transform: "rotate(180deg)" }}/></button>{selectedPreview ? <button aria-label="Воспроизвести или приостановить" className="play-control" onClick={() => void togglePreview()} type="button"><Play size={21} fill="currentColor"/></button> : null}<button aria-label="Следующая сцена" disabled={!selectedScene || scenes.at(-1)?.id === selectedScene.id} onClick={() => selectRelative(1)} type="button"><Play size={17}/></button></div><div className="transport-actions">{selectedPreview ? <button aria-label="Полноэкранный режим" onClick={() => void openFullscreen()} type="button"><Expand size={17}/></button> : null}</div></div>
      <div className="seek-line"><i style={{ width: `${progress}%` }}/><b style={{ left: `${progress}%` }}/></div>
    </section>

    <aside className="production-panel"><div className="panel-tabs">{(["overview","scenes","memory"] as const).map((tab) => <button className={rightTab === tab ? "active" : ""} key={tab} onClick={() => setRightTab(tab)} type="button">{{ overview: "Обзор", scenes: "Сцены", memory: "Память" }[tab]}</button>)}</div>{rightTab === "overview" ? <ProductionOverview detail={detail} onShowScenes={() => setRightTab("scenes")} selectedSceneId={selectedScene?.id ?? ""} setSelectedSceneId={setSelectedSceneId}/> : null}{rightTab === "scenes" ? <SceneList scenes={scenes} selectedSceneId={selectedScene?.id ?? ""} setSelectedSceneId={setSelectedSceneId}/> : null}{rightTab === "memory" ? <MemorySummary plan={plan}/> : null}</aside>

    <section className="timeline-panel" aria-label="Монтажная шкала фильма"><div className="timeline-toolbar"><div><strong>ГЛАВНАЯ МОНТАЖНАЯ ШКАЛА</strong></div><strong className="timeline-time">{selectedScene ? formatTimecode(sceneStart(scenes, selectedScene.id)) : "00:00:00"} / {formatTimecode(duration)}</strong><div><button aria-label="Уменьшить масштаб" onClick={() => setTimelineZoom((value) => Math.max(50,value-25))} type="button"><ZoomOut size={15}/></button><input aria-label="Масштаб монтажной шкалы" max="250" min="50" onChange={(event) => setTimelineZoom(Number(event.target.value))} type="range" value={timelineZoom}/><button aria-label="Увеличить масштаб" onClick={() => setTimelineZoom((value) => Math.min(250,value+25))} type="button"><ZoomIn size={15}/></button></div></div><div className="time-ruler">{[0,.2,.4,.6,.8,1].map((ratio) => <span key={ratio}>{formatTimecode(duration*ratio)}</span>)}</div><div className="tracks" style={{ minWidth: `${timelineZoom}%` }}><div className="playhead" style={{ left: `${selectedScene && duration ? sceneStart(scenes,selectedScene.id)/duration*100 : 0}%` }}><i/></div>{tracks.map((track) => <TimelineTrack key={track.label} track={track} selectedSceneId={selectedScene?.id ?? ""} setSelectedSceneId={setSelectedSceneId}/>)}</div></section>

    {budgetOpen ? <BudgetConfirmation budget={budget} estimate={estimate} modelName={model.displayName} onClose={() => setBudgetOpen(false)} onConfirm={() => void startFullProduction()} busy={busy === "generating"} duration={duration} resolution={resolution} overBudget={costOverBudget}/> : null}

    <footer className="studio-statusbar"><div><Gauge size={15}/><span>Активная очередь</span><b>{activeJobs.length}</b></div><div className="status-progress"><span>{detail ? `${projectStatusRu(detail.project.status)} · ${detail.project.completedShots}/${detail.project.totalShots} кадров` : "Нет активного производства"}</span><i><b style={{ width: `${progress}%` }}/></i><strong>{progress}%</strong></div><div className="status-progress spend"><span>Расход API проекта</span><i><b style={{ width: `${detail?.project.maximumBudgetUsd ? Math.min(100,detail.project.spentUsd/detail.project.maximumBudgetUsd*100) : 0}%` }}/></i><strong>${Number(detail?.project.spentUsd ?? 0).toFixed(2)} / ${Number(detail?.project.maximumBudgetUsd ?? budget).toFixed(2)}</strong></div><div><StatusDot tone={detail?.project.status === "failed" ? "red" : detail?.project.status === "paused" ? "amber" : "teal"}/><span>{notice}</span></div><div><span>{resolution} · {aspectRatio}{latestCheckpoint ? ` · CP ${latestCheckpoint.sequence}` : ""}</span></div></footer>
  </div>;
}

function ProductionOverview({ detail, selectedSceneId, setSelectedSceneId, onShowScenes }: { detail: DetailPayload | null; selectedSceneId: string; setSelectedSceneId: (id: string) => void; onShowScenes: () => void }) {
  const plan = detail?.plan; const status = detail?.project.status; const jobs = detail?.jobs ?? []; const checkpoints = detail?.checkpoints ?? [];
  const stages = [
    ["История", plan ? "complete" : "waiting"], ["Персонажи", plan?.characters.length ? "complete" : "waiting"], ["Раскадровка", plan?.scenes.length ? "complete" : "waiting"],
    ["Генерация сцен", ["queued","generating"].includes(status ?? "") ? "active" : status === "completed" ? "complete" : "waiting"],
    ["Согласованность", jobs.some((job) => job.state === "validating") ? "active" : status === "completed" ? "complete" : "waiting"],
    ["Монтаж", status === "assembling" ? "active" : status === "completed" ? "complete" : "waiting"], ["Финальный контроль", status === "completed" ? "complete" : "waiting"],
  ];
  return <div className="production-content"><h2>Этапы производства</h2><div className="stage-list">{stages.map(([name,state]) => <div key={name}><span className={`stage-icon ${state}`}>{state === "complete" ? <Check size={12}/> : state === "active" ? <span/> : <Square size={10}/>}</span><strong>{name}</strong><em>{state === "active" ? "В работе" : state === "complete" ? "Готово" : "Ожидание"}</em></div>)}</div><div className="score-card"><span>Состояние проекта</span><div><Lightbulb size={20}/><p>{detail ? `Готово: ${detail.project.completedShots} · осталось: ${detail.project.totalShots-detail.project.completedShots}` : "Сначала создайте план фильма"}<br/><small>Ошибок заданий: {jobs.filter((job) => job.state === "failed").length}</small></p></div></div><div className="checkpoint-card"><div><span>Постоянные контрольные точки</span></div><p><Check size={13}/>{checkpoints.length ? `Загружено контрольных точек: ${checkpoints.length}; последняя последовательность ${checkpoints[0].sequence}` : "Контрольная точка кадров ещё не создана"}</p></div><h2>Сцены</h2><div className="scene-strip">{(plan?.scenes ?? []).slice(0,4).map((scene) => <button className={selectedSceneId === scene.id ? "selected" : ""} key={scene.id} onClick={() => setSelectedSceneId(scene.id)} type="button"><span className="resource-placeholder"><Film size={16}/></span><strong>Сцена {scene.number}</strong><small>{formatTimecode(scene.durationSeconds)}</small></button>)}</div>{(plan?.scenes.length ?? 0) > 4 ? <Button className="wide-inline" onClick={onShowScenes} variant="ghost">Открыть все сцены: {plan?.scenes.length}</Button> : null}</div>;
}
function SceneList({ scenes, selectedSceneId, setSelectedSceneId }: { scenes: Scene[]; selectedSceneId: string; setSelectedSceneId: (id: string) => void }) { return <div className="production-content"><h2>Граф сцен</h2><div className="inspector-list">{scenes.map((scene) => <button className={selectedSceneId === scene.id ? "selected" : ""} key={scene.id} onClick={() => setSelectedSceneId(scene.id)} type="button"><ListVideo size={15}/><span><strong>Сцена {scene.number}</strong><small>{scene.title}</small></span><em>{formatTimecode(scene.durationSeconds)}</em></button>)}</div>{!scenes.length ? <p className="field-help">Сценарий ещё не создан.</p> : null}</div>; }
function MemorySummary({ plan }: { plan: MoviePlan | null | undefined }) { const facts = [...(plan?.characters ?? []).flatMap((character) => Object.entries(character.locks).filter(([,locked]) => locked).map(([key]) => `${character.name} · ${lockLabelRu(key)}`)), ...(plan?.locations ?? []).filter((location) => location.designLocked).map((location) => `${location.name} · ${lockLabelRu("design")}`)]; return <div className="production-content"><h2>Заблокированные параметры памяти</h2><div className="memory-facts">{facts.map((fact) => <p key={fact}><Lock size={13}/>{fact}</p>)}{!facts.length ? <p>Параметры согласованности не заблокированы.</p> : null}</div><div className="score-card"><span>Сборщик контекста</span><div><Lightbulb size={20}/><p>{plan ? `Персонажей: ${plan.characters.length} · локаций: ${plan.locations.length}` : "Память проекта ещё не создана"}<br/><small>Для каждого кадра передаётся только относящийся к нему контекст.</small></p></div></div></div>; }
function TimelineTrack({ track, selectedSceneId, setSelectedSceneId }: { track: Track; selectedSceneId: string; setSelectedSceneId: (id: string) => void }) { const Icon = track.icon; return <div className={`timeline-track tone-${track.tone}`}><div className="track-head"><Icon size={14}/><span>{track.label}</span><Eye size={13}/><Lock size={12}/></div><div className="track-clips">{track.clips.map((clip) => <button className={selectedSceneId === clip.sceneId ? "selected" : ""} key={clip.id} onClick={() => setSelectedSceneId(clip.sceneId)} style={{ flexGrow: Math.max(.5,clip.duration) }} type="button"><span>{clip.label}</span></button>)}</div></div>; }
function BudgetConfirmation({ estimate, budget, modelName, duration, resolution, onClose, onConfirm, busy, overBudget }: { estimate: ReturnType<typeof estimateGeneration>; budget: number; modelName: string; duration: number; resolution: Resolution; onClose: () => void; onConfirm: () => void; busy: boolean; overBudget: boolean }) { return <div className="budget-confirm"><div className="budget-title"><strong>Подтверждение платной генерации</strong><button aria-label="Закрыть расчёт стоимости" onClick={onClose} type="button"><X size={15}/></button></div><dl><div><dt>Модель</dt><dd>{modelName}</dd></div><div><dt>Фильм</dt><dd>{formatDuration(duration)} · {resolution}</dd></div><div><dt>Запланировано генераций</dt><dd>{estimate.shots}</dd></div><div><dt>Видео</dt><dd>${estimate.videoUsd.toFixed(2)}</dd></div><div><dt>Звук</dt><dd>${estimate.audioUsd.toFixed(2)}</dd></div><div><dt>Резерв на повторы</dt><dd>${estimate.retriesReserveUsd.toFixed(2)}</dd></div></dl><div className="cost-total"><span>Примерная сумма</span><strong>${estimate.estimatedTotalUsd.toFixed(2)}</strong></div><Button disabled={overBudget} loading={busy} onClick={onConfirm} variant="primary">{overBudget ? `Увеличьте бюджет $${budget.toFixed(2)}` : `Подтвердить и создать · максимум $${budget.toFixed(2)}`}</Button><p>До подтверждения платные запросы не запускаются. При достижении бюджета проект ставится на паузу.</p></div>; }

function resolutionOptionLabel(modelId: string, resolution: Resolution): string {
  if (resolution === "preview") return "Предпросмотр / черновик";
  const label = resolution === "4k" ? "4K" : resolution;
  return isNativeResolution(modelId, resolution) ? `${label} · нативно` : `${label} · мастеринг студии`;
}
function buildTracks(scenes: Scene[]): Track[] { const shotRows = scenes.flatMap((scene) => scene.shots.map((shot) => ({ scene, shot }))); return [
  { label: "Видео", icon: Film, tone: "video", clips: shotRows.map(({scene,shot}) => ({ id: `v:${shot.id}`, sceneId: scene.id, label: shot.title, duration: shot.durationSeconds })) },
  { label: "Диалоги", icon: MessageSquareText, tone: "dialogue", clips: shotRows.map(({scene,shot}) => ({ id: `d:${shot.id}`, sceneId: scene.id, label: shot.audioContext.dialogue.map((line) => `${line.characterName}: ${line.text}`).join(" · ") || "Без диалога", duration: shot.durationSeconds })) },
  { label: "Музыка", icon: Music2, tone: "music", clips: shotRows.map(({scene,shot}) => ({ id: `m:${shot.id}`, sceneId: scene.id, label: shot.audioContext.musicCue ?? "Без музыки", duration: shot.durationSeconds })) },
  { label: "Эффекты", icon: Volume2, tone: "sfx", clips: shotRows.map(({scene,shot}) => ({ id: `s:${shot.id}`, sceneId: scene.id, label: shot.audioContext.soundEffects.join(", ") || "Без эффектов", duration: shot.durationSeconds })) },
  { label: "Атмосфера", icon: Waves, tone: "ambience", clips: shotRows.map(({scene,shot}) => ({ id: `a:${shot.id}`, sceneId: scene.id, label: shot.audioContext.ambience.join(", ") || "Без атмосферы", duration: shot.durationSeconds })) },
  { label: "Субтитры", icon: Subtitles, tone: "subtitles", clips: shotRows.map(({scene,shot}) => ({ id: `t:${shot.id}`, sceneId: scene.id, label: shot.audioContext.dialogue.map((line) => line.text).join(" · ") || "Без субтитров", duration: shot.durationSeconds })) },
]; }
function sceneStart(scenes: Scene[], sceneId: string) { let cursor = 0; for (const scene of scenes) { if (scene.id === sceneId) return cursor; cursor += scene.durationSeconds; } return 0; }
function formatTimecode(seconds: number) { const value = Math.max(0,Math.floor(seconds)); const hours = Math.floor(value/3600); const minutes = Math.floor(value%3600/60); const secs = value%60; return `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(secs).padStart(2,"0")}`; }
