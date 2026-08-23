"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Film, Lock, MessageSquareText, Music2, Play, Send, Subtitles, Volume2, Waves } from "lucide-react";
import { preservePreviewUrls, type MoviePlan, type ProjectRecord, type Scene } from "@/domain/movie";
import type { Resolution } from "@/domain/video-models";
import { errorMessageRu } from "@/lib/ru";
import { Button, PanelHeading, StatusDot } from "./ui";

type TimelineClip = { id: string; scene_id: string; shot_id: string; track: TrackName; start_seconds: string; duration_seconds: string; source_version: number; metadata: Record<string, unknown> };
type Version = { shot_id: string; version: number; reason: string; continuity_score: string | null; active: boolean; created_at: string };
type ProjectDetail = { project: ProjectRecord; plan: MoviePlan | null; timeline: TimelineClip[]; versions: Version[] };
type PreviewClip = { shot_id: string; scene_id: string; url: string; duration_seconds: string; continuity_score: string | null; version: number };
type PreviewPayload = { clips: PreviewClip[]; movieUrl: string | null };
type Impact = { intent: string; affected: Array<{ sceneId: string; shotId: string; dialogueIds: string[]; tracks: string[] }>; unaffected: { before: string[]; after: string[] }; requiresVideoRegeneration: boolean; reason: string };
type TrackName = "video" | "dialogue" | "music" | "sfx" | "ambience" | "subtitles";

const trackConfig: Record<TrackName, { label: string; icon: typeof Film; tone: string }> = {
  video: { label: "Видео", icon: Film, tone: "video" }, dialogue: { label: "Диалоги", icon: MessageSquareText, tone: "dialogue" },
  music: { label: "Музыка", icon: Music2, tone: "music" }, sfx: { label: "Эффекты", icon: Volume2, tone: "sfx" },
  ambience: { label: "Атмосфера", icon: Waves, tone: "ambience" }, subtitles: { label: "Субтитры", icon: Subtitles, tone: "subtitles" },
};
const trackOrder = Object.keys(trackConfig) as TrackName[];

export function EditorWorkspace() {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [preview, setPreview] = useState<PreviewPayload>({ clips: [], movieUrl: null });
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [selectedShotId, setSelectedShotId] = useState("");
  const [command, setCommand] = useState("");
  const [impact, setImpact] = useState<Impact | null>(null);
  const [busy, setBusy] = useState<"edit" | "export" | "scene-export" | null>(null);
  const [notice, setNotice] = useState("");
  const [exportResolution, setExportResolution] = useState<Exclude<Resolution, "preview">>("1080p");
  const videoRef = useRef<HTMLVideoElement>(null);
  const autoContinueRef = useRef(false);

  const load = useCallback(async () => {
    const queryId = new URL(window.location.href).searchParams.get("project");
    const projectId = queryId ?? localStorage.getItem("cineforge.projectId");
    if (!projectId) { setNotice("Сначала откройте или создайте проект фильма."); return; }
    localStorage.setItem("cineforge.projectId", projectId);
    try {
      const [detailResponse, previewResponse] = await Promise.all([
        fetch(`/api/projects?id=${encodeURIComponent(projectId)}`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/preview`, { cache: "no-store" }),
      ]);
      const detailPayload = await detailResponse.json();
      if (!detailResponse.ok || detailPayload.infrastructure === "offline") throw new Error(detailPayload.error ?? "Инфраструктура проектов недоступна.");
      setDetail(detailPayload);
      setExportResolution((current) => current === "4k" ? current : detailPayload.project.resolution === "4k" ? "4k" : "1080p");
      setSelectedSceneId((current) => current || detailPayload.plan?.scenes?.[0]?.id || "");
      if (previewResponse.ok) {
        const nextPreview = await previewResponse.json() as PreviewPayload;
        setPreview((current) => ({ ...nextPreview, clips: preservePreviewUrls(current.clips, nextPreview.clips) }));
        setSelectedShotId((current) => nextPreview.clips.some((clip) => clip.shot_id === current) ? current : nextPreview.clips[0]?.shot_id ?? "");
      }
      else setPreview({ clips: [], movieUrl: null });
      setNotice("");
    } catch (error) { setDetail(null); setNotice(errorMessageRu(error, "Не удалось загрузить проект.")); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const scenes = detail?.plan?.scenes ?? [];
  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? scenes[0];
  const selectedPreview = preview.clips.find((clip) => clip.shot_id === selectedShotId && clip.scene_id === selectedScene?.id)
    ?? preview.clips.find((clip) => clip.scene_id === selectedScene?.id)
    ?? null;
  const versions = detail?.versions.filter((version) => selectedScene?.shots.some((shot) => shot.id === version.shot_id)) ?? [];
  const selectedStart = Number(detail?.timeline.find((clip) => clip.scene_id === selectedScene?.id)?.start_seconds ?? 0);
  const totalDuration = detail?.project.durationSeconds ?? 0;
  const canExport = Boolean(detail?.project.totalShots && detail.project.completedShots >= detail.project.totalShots);
  const tracks = useMemo(() => trackOrder.map((name) => ({ ...trackConfig[name], name, clips: (detail?.timeline ?? []).filter((clip) => clip.track === name) })), [detail]);

  useEffect(() => {
    if (!autoContinueRef.current || !selectedPreview) return;
    autoContinueRef.current = false;
    void videoRef.current?.play().catch(() => setNotice("Следующая сцена выбрана; браузер попросил нажать воспроизведение ещё раз."));
  }, [selectedPreview]);

  async function applyMinimalEdit() {
    const projectId = detail?.project.id;
    if (!projectId || !command.trim()) { setNotice("Введите команду редактирования для активного проекта."); return; }
    setBusy("edit"); setImpact(null); setNotice("Выполняю анализ затрагиваемой области…");
    try {
      const response = await fetch(`/api/projects/${projectId}/edits`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command, sceneId: selectedScene?.id, shotId: selectedPreview?.shot_id }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Не удалось применить правку.");
      setImpact(payload.impact);
      setNotice(payload.videoFramesPreserved ? "Правка диалога поставлена в очередь; исходные видеокадры сохранены." : "На повторную генерацию поставлен только затронутый кадр.");
      await load();
    } catch (error) { setNotice(errorMessageRu(error, "Не удалось применить правку.")); }
    finally { setBusy(null); }
  }

  async function queueExport(sceneOnly = false) {
    const project = detail?.project; if (!project || !canExport) { setNotice("Экспорт станет доступен, когда для каждого запланированного кадра будет создана контрольная точка."); return; }
    if (sceneOnly && !selectedScene) return;
    setBusy(sceneOnly ? "scene-export" : "export"); setNotice(sceneOnly ? `Собираю сцену ${selectedScene.number} в отдельный MP4…` : "Собираю все сцены в один MP4 и выполняю финальную проверку…");
    try {
      const response = await fetch(`/api/projects/${project.id}/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "mp4", resolution: exportResolution, ...(sceneOnly ? { sceneId: selectedScene.id } : {}) }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Не удалось поставить экспорт в очередь.");
      await downloadWhenExportReady(project.id, payload.exportId);
      setNotice(sceneOnly ? `Сцена ${selectedScene.number} готова и отправлена на скачивание.` : "Весь фильм собран и отправлен на скачивание.");
    } catch (error) { setNotice(errorMessageRu(error, "Экспорт не выполнен.")); }
    finally { setBusy(null); }
  }

  function continuePreview() {
    if (!selectedPreview) return;
    const index = preview.clips.findIndex((clip) => clip.shot_id === selectedPreview.shot_id);
    const next = preview.clips[index + 1];
    if (!next) return;
    autoContinueRef.current = true;
    setSelectedSceneId(next.scene_id);
    setSelectedShotId(next.shot_id);
  }

  async function downloadWhenExportReady(projectId: string, exportId: string) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const response = await fetch(`/api/projects/${projectId}/export?exportId=${encodeURIComponent(exportId)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Не удалось проверить экспорт.");
      if (payload.state === "completed" && payload.url) { window.location.assign(payload.url); return; }
      if (payload.state === "failed") throw new Error("Финальная проверка экспортируемого видео не пройдена.");
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    }
    throw new Error("Экспорт продолжается дольше ожидаемого. Он сохранён в разделе «Рендеры».");
  }

  if (!detail?.plan) return <div className="empty-state editor-empty"><div><Film size={30}/><h2>{notice || "Нет сценария для редактирования"}</h2><p>Редактор показывает сохранённые сцены, созданные материалы и версии. Создайте или откройте спланированный проект фильма.</p><a className="button button-primary" href="/projects">Открыть проекты</a></div></div>;

  return <div className="editor-grid">
    <aside className="editor-bin"><PanelHeading>Сцены · {scenes.length}</PanelHeading><div className="bin-scenes">{scenes.map((scene) => <SceneButton key={scene.id} scene={scene} selected={selectedScene?.id === scene.id} versionCount={detail.versions.filter((version) => scene.shots.some((shot) => shot.id === version.shot_id)).length} onClick={() => { setSelectedSceneId(scene.id); setSelectedShotId(preview.clips.find((clip) => clip.scene_id === scene.id)?.shot_id ?? ""); setImpact(null); }}/>)}</div><PanelHeading>Версии</PanelHeading><div className="memory-facts" style={{ padding: 8 }}>{versions.length ? versions.map((version) => <p key={`${version.shot_id}:${version.version}`}>{version.active ? <Lock size={12}/> : <Check size={12}/>} {version.shot_id} · v{version.version} · {version.reason}{version.continuity_score ? ` · проверка ${Number(version.continuity_score).toFixed(0)}` : ""}</p>) : <p>Для этой сцены ещё нет созданных версий.</p>}</div></aside>
    <section className="editor-preview"><div className="preview-frame">{selectedPreview ? <video controls key={`${selectedPreview.shot_id}:${selectedPreview.version}`} onEnded={continuePreview} ref={videoRef} src={selectedPreview.url}/> : <div className="preview-empty"><Film size={34}/><strong>Кадр ещё не создан</strong><span>Настоящий предпросмотр появится после первой завершённой контрольной точки.</span></div>}<div className="preview-corner"><span>СЦЕНА {selectedScene.number}</span><strong>{selectedScene.title}</strong></div></div><div className="transport"><strong>{formatTimecode(selectedStart)}</strong><span className="fit-control">{selectedPreview ? `v${selectedPreview.version}` : "Нет медиа"}</span><div className="transport-center">{selectedPreview ? <button aria-label="Воспроизвести или поставить на паузу" className="play-control" onClick={() => videoRef.current?.paused ? void videoRef.current.play() : videoRef.current?.pause()} type="button"><Play size={20} fill="currentColor"/></button> : null}</div><div className="transport-actions"><label className="export-quality"><span>Качество</span><select aria-label="Разрешение экспорта" onChange={(event) => setExportResolution(event.target.value as Exclude<Resolution, "preview">)} value={exportResolution}><option value="1080p">1080p</option><option value="4k">4K</option></select></label><Button disabled={!canExport} loading={busy === "scene-export"} onClick={() => void queueExport(true)} variant="ghost"><Download size={14}/>Скачать сцену</Button><Button disabled={!canExport} loading={busy === "export"} onClick={() => void queueExport()} variant="primary"><Download size={14}/>Экспортировать всё</Button></div></div></section>
    <aside className="edit-chat"><PanelHeading>Редактировать с ИИ</PanelHeading><div className="edit-chat-log"><div className="message assistant" style={{ gridTemplateColumns: "24px 1fr" }}><span className="message-avatar"><MessageSquareText size={12}/></span><div className="message-content"><p>Опишите изменение, указав время или номер сцены. CineForge вычислит минимально затрагиваемую область до постановки работы в очередь.</p></div></div>{impact ? <div className="impact-box"><h3>Анализ изменений · {impact.intent}</h3><p><strong>Будет изменено</strong><br/>{impact.affected.map((item) => `${item.sceneId} / ${item.shotId} / ${item.tracks.join(", ")}`).join("; ")}</p><p><strong>Останется без изменений</strong><br/>{impact.unaffected.before.length + impact.unaffected.after.length} кадров сохранят текущие версии.</p><p>{impact.reason}</p></div> : null}{notice ? <div className="secure-note" style={{ marginTop: 10 }}><StatusDot tone={notice.toLowerCase().includes("ошиб") ? "red" : "teal"}/>{notice}</div> : null}</div><div className="edit-composer"><textarea aria-label="Редактировать с ИИ" onChange={(event) => setCommand(event.target.value)} placeholder="Например: в сцене 4 замени реплику, но не изменяй видео." value={command}/><Button disabled={!command.trim()} loading={busy === "edit"} onClick={() => void applyMinimalEdit()} variant="primary"><Send size={13}/>Проанализировать и применить</Button></div></aside>
    <section className="editor-timeline"><div className="timeline-toolbar"><div><strong>ГЛАВНЫЙ ТАЙМЛАЙН</strong></div><strong className="timeline-time">{formatTimecode(selectedStart)} / {formatTimecode(totalDuration)}</strong><div><span className="field-help">Только сохранённые клипы</span></div></div><div className="time-ruler">{[0,.25,.5,.75,1].map((ratio) => <span key={ratio}>{formatTimecode(totalDuration * ratio)}</span>)}</div><div className="tracks"><div className="playhead" style={{ left: `${Math.max(0, Math.min(100, totalDuration ? selectedStart / totalDuration * 100 : 0))}%` }}><i/></div>{tracks.map((track) => { const Icon = track.icon; return <div className={`timeline-track tone-${track.tone}`} key={track.name}><div className="track-head"><Icon size={13}/><span>{track.label}</span><span/><Lock size={11}/></div><div className="track-clips">{track.clips.map((clip) => <button className={clip.scene_id === selectedScene?.id && clip.shot_id === selectedPreview?.shot_id ? "selected" : ""} key={clip.id} onClick={() => { setSelectedSceneId(clip.scene_id); setSelectedShotId(clip.shot_id); }} style={{ flexGrow: Math.max(.5, Number(clip.duration_seconds)) }} type="button"><span>{clipLabel(track.name, clip)}</span></button>)}</div></div>; })}</div></section>
  </div>;
}

function SceneButton({ scene, selected, versionCount, onClick }: { scene: Scene; selected: boolean; versionCount: number; onClick: () => void }) { return <button className={`bin-scene ${selected ? "selected" : ""}`} onClick={onClick} type="button"><span className="bin-thumb resource-placeholder"><Film size={16}/></span><span><strong>Сцена {scene.number} · {scene.title}</strong><small>{formatTimecode(scene.durationSeconds)} · кадров: {scene.shots.length} · версий: {versionCount}</small></span></button>; }
function formatTimecode(seconds: number) { const value = Math.max(0, Math.floor(seconds)); const hours = Math.floor(value / 3600); const minutes = Math.floor(value % 3600 / 60); const secs = value % 60; return `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(secs).padStart(2,"0")}`; }
function clipLabel(track: TrackName, clip: TimelineClip) { const metadata = clip.metadata ?? {}; if (track === "video") return String(metadata.title ?? clip.shot_id); if (track === "music") return String(metadata.cue ?? "Без музыкальной темы"); if (track === "sfx") return Array.isArray(metadata.effects) ? metadata.effects.join(", ") || "Без эффектов" : "Эффекты"; if (track === "ambience") return Array.isArray(metadata.ambience) ? metadata.ambience.join(", ") || "Без атмосферы" : "Атмосфера"; if (track === "dialogue") { const dialogue = metadata.dialogue as Array<{ text?: string }> | undefined; return dialogue?.map((item) => item.text).filter(Boolean).join(" · ") || "Без диалога"; } if (track === "subtitles") { const lines = metadata.lines as Array<{ text?: string }> | undefined; return lines?.map((item) => item.text).filter(Boolean).join(" · ") || "Без субтитров"; } return clip.shot_id; }
