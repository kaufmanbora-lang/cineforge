"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Aperture, Check, CircleDollarSign, Clapperboard, Expand, Eye, Film, Gauge,
  ImageIcon, Lightbulb, ListVideo, Lock, MessageSquareText, Music2, Play,
  Sparkles, Square, Subtitles, Volume2, Waves, X, Zap, ZoomIn, ZoomOut,
} from "lucide-react";
import { estimateGeneration, formatDuration } from "@/domain/estimation";
import type { MoviePlan, ProjectRecord, Scene } from "@/domain/movie";
import { GOOGLE_VIDEO_MODELS, normalizeResolution, type AspectRatio, type Resolution } from "@/domain/video-models";
import { Button, Segmented, StatusDot } from "./ui";

type JobRow = { id: string; type: string; state: string; scene_id: string | null; shot_id: string | null; last_error: unknown };
type CheckpointRow = { sequence: string; event_type: string; completed_shot_ids: string[]; failed_shot_ids: string[]; pending_shot_ids: string[]; created_at: string };
type DetailPayload = { project: ProjectRecord; plan: MoviePlan | null; jobs: JobRow[]; checkpoints: CheckpointRow[] };
type PreviewClip = { shot_id: string; scene_id: string; url: string; version: number; continuity_score: string | null };
type PreviewPayload = { clips: PreviewClip[]; movieUrl: string | null };
type Track = { label: string; icon: typeof Film; tone: string; clips: Array<{ id: string; sceneId: string; label: string; duration: number }> };

export function StudioWorkspace() {
  const [mode, setMode] = useState<"quick" | "advanced">("quick");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(60);
  const [customDuration, setCustomDuration] = useState(false);
  const [modelId, setModelId] = useState("veo-3.1-fast-generate-preview");
  const [resolution, setResolution] = useState<Resolution>("720p");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [draft, setDraft] = useState(true);
  const [budget, setBudget] = useState(25);
  const [projectId, setProjectId] = useState("");
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [preview, setPreview] = useState<PreviewPayload>({ clips: [], movieUrl: null });
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [rightTab, setRightTab] = useState<"overview" | "scenes" | "memory">("overview");
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [busy, setBusy] = useState<"planning" | "generating" | null>(null);
  const [notice, setNotice] = useState("Enter a movie idea to begin.");
  const [accountModelIds, setAccountModelIds] = useState<Set<string> | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(100);
  const videoRef = useRef<HTMLVideoElement>(null);

  const model = GOOGLE_VIDEO_MODELS[modelId];
  const estimate = useMemo(() => estimateGeneration({ durationSeconds: duration, modelId, resolution }), [duration, modelId, resolution]);
  const plan = detail?.plan;
  const scenes = plan?.scenes ?? [];
  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? scenes[0];
  const selectedPreview = preview.clips.find((clip) => clip.scene_id === selectedScene?.id) ?? null;
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
      if (!detailResponse.ok || payload.infrastructure === "offline") throw new Error(payload.error ?? "Project infrastructure is offline.");
      setDetail(payload); setProjectId(id); localStorage.setItem("cineforge.projectId", id);
      setPrompt(payload.project.prompt); setDuration(payload.project.durationSeconds); setModelId(payload.project.modelId);
      setResolution(payload.project.resolution); setAspectRatio(payload.project.aspectRatio); setBudget(Number(payload.project.maximumBudgetUsd));
      setDraft(payload.project.renderTier !== "final");
      setSelectedSceneId((current) => current && payload.plan?.scenes.some((scene: Scene) => scene.id === current) ? current : payload.plan?.scenes?.[0]?.id ?? "");
      if (previewResponse.ok) setPreview(await previewResponse.json());
      if (!quiet) setNotice(payload.plan ? `${payload.plan.scenes.length} scenes loaded from Project Memory.` : "Project has no screenplay yet.");
    } catch (error) { if (!quiet) setNotice(error instanceof Error ? error.message : "Unable to load the project."); }
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
        setNotice(`${prepared.shots} shots prepared by AI Screenwriter.`);
      }
      if (existingId) await loadProject(existingId);
      try {
        const response = await fetch("/api/models/google", { cache: "no-store" }); const payload = await response.json();
        if (!payload.connected) { setAccountModelIds(new Set()); setNotice((current) => existingId ? current : "Connect Google API in Settings before video generation."); return; }
        const available = new Set<string>((payload.models ?? []).filter((entry: { available?: boolean; selectable?: boolean }) => entry.available && entry.selectable !== false).map((entry: { id: string }) => entry.id));
        setAccountModelIds(available);
        if (available.size) setModelId((current) => { if (available.has(current)) return current; const next = [...available][0]; setResolution((value) => normalizeResolution(next, value)); return next; });
        else setNotice("No supported Google video model is enabled for this API project.");
      } catch { setAccountModelIds(new Set()); setNotice("Unable to verify Google video model access."); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadProject]);

  useEffect(() => {
    if (!projectId || !detail || ["draft","planned","completed","paused","failed","cancelled"].includes(detail.project.status)) return;
    const interval = window.setInterval(() => void loadProject(projectId, true), 5_000);
    return () => window.clearInterval(interval);
  }, [detail, loadProject, projectId]);

  function changeModel(nextId: string) { setModelId(nextId); setResolution((current) => normalizeResolution(nextId, current)); }
  function startNewProject() {
    setProjectId(""); setDetail(null); setPreview({ clips: [], movieUrl: null }); setSelectedSceneId(""); setPrompt(""); setBudgetOpen(false);
    localStorage.removeItem("cineforge.projectId"); sessionStorage.removeItem("cineforge.preparedProject"); setNotice("Enter a movie idea to begin a new project.");
  }

  async function createPlan() {
    if (prompt.trim().length < 10) { setNotice("Describe the movie in at least 10 characters."); return; }
    if (accountModelIds && !accountModelIds.has(modelId)) { setNotice("The selected Google video model is not available for this API key."); return; }
    setBusy("planning"); setNotice("Creating the Movie Project…");
    try {
      const created = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Untitled Movie", prompt, durationSeconds: duration, modelId, resolution, aspectRatio, mode, renderTier: draft ? "draft" : "final", maximumBudgetUsd: budget }) });
      const createdPayload = await created.json(); if (!created.ok) throw new Error(createdPayload.error ?? "Unable to create project.");
      const id = createdPayload.projectId as string; setProjectId(id); localStorage.setItem("cineforge.projectId", id); setNotice("Creating screenplay and shot graph…");
      const planned = await fetch(`/api/projects/${id}/plan`, { method: "POST" }); const planPayload = await planned.json(); if (!planned.ok) throw new Error(planPayload.error ?? "Unable to plan movie.");
      await loadProject(id, true); setBudgetOpen(true); setNotice(`${planPayload.scenes} scenes and ${planPayload.shots} shots planned.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Planning failed."); }
    finally { setBusy(null); }
  }

  async function confirmGeneration() {
    if (!projectId || !plan) { setNotice("Plan the movie before starting generation."); return; }
    setBusy("generating"); setNotice("Queueing generation jobs…");
    try {
      const response = await fetch(`/api/projects/${projectId}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, maximumBudgetUsd: budget }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Unable to start generation.");
      setBudgetOpen(false); setNotice(`${payload.queued} new jobs queued. Existing completed shots were not duplicated.`); await loadProject(projectId, true);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Generation failed."); }
    finally { setBusy(null); }
  }

  function selectRelative(offset: number) { const index = scenes.findIndex((scene) => scene.id === selectedScene?.id); const next = scenes[Math.max(0, Math.min(scenes.length - 1, index + offset))]; if (next) setSelectedSceneId(next.id); }
  async function togglePreview() { if (!videoRef.current) return; if (videoRef.current.paused) await videoRef.current.play(); else videoRef.current.pause(); }
  async function openFullscreen() { const node = videoRef.current?.parentElement; if (node?.requestFullscreen) await node.requestFullscreen(); }

  const tracks = buildTracks(scenes);
  const planReady = Boolean(plan);
  const costOverBudget = estimate.estimatedTotalUsd > budget;

  return <div className="studio-grid">
    <section className="brief-panel" aria-label="Movie brief">
      <div className="section-title"><h1>{plan ? detail?.project.title : "Describe your movie"}</h1>{plan ? <Button onClick={startNewProject} variant="ghost">New project</Button> : null}</div>
      {plan ? <div className="secure-note"><StatusDot tone="green"/>Structured MoviePlan is persisted. Use AI Screenwriter for targeted screenplay changes.</div> : <Segmented value={mode} onChange={setMode} options={[{ value: "quick", label: "Quick Create" }, { value: "advanced", label: "Advanced" }]}/>} 
      <div className="prompt-box"><textarea aria-label="Describe your movie" disabled={Boolean(plan)} maxLength={20_000} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the story, characters, setting and desired tone…" value={prompt}/><span>{prompt.length} / 20,000</span></div>
      <div className="control-stack">
        <label><span><Aperture size={15}/>Duration</span><select disabled={Boolean(plan)} onChange={(event) => { if (event.target.value === "custom") setCustomDuration(true); else { setCustomDuration(false); setDuration(Number(event.target.value)); } }} value={customDuration ? "custom" : duration}>{[10,30,60,180,300,600,900,1200,1800,2700,3600].map((seconds) => <option key={seconds} value={seconds}>{formatDuration(seconds)}</option>)}<option value="custom">Custom Duration…</option></select></label>
        {customDuration ? <label><span>Seconds</span><input aria-label="Custom duration in seconds" max="3600" min="1" onChange={(event) => setDuration(Math.max(1, Math.min(3600, Number(event.target.value) || 1)))} type="number" value={duration}/></label> : null}
        <label><span><Sparkles size={15}/>Model</span><select disabled={Boolean(plan)} onChange={(event) => changeModel(event.target.value)} value={modelId}>{Object.values(GOOGLE_VIDEO_MODELS).map((entry) => <option disabled={accountModelIds !== null && !accountModelIds.has(entry.id)} key={entry.id} value={entry.id}>{entry.displayName}{accountModelIds !== null && !accountModelIds.has(entry.id) ? " · unavailable" : ""}</option>)}</select></label>
        <div className="split-control"><label><span><ImageIcon size={15}/>Resolution</span><select disabled={Boolean(plan)} onChange={(event) => setResolution(event.target.value as Resolution)} value={resolution}>{model.resolutions.map((entry) => <option key={entry} value={entry}>{entry === "preview" ? "Preview / Draft" : entry}</option>)}</select></label><label className="aspect"><span>Aspect</span><select disabled={Boolean(plan)} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)} value={aspectRatio}>{model.aspectRatios.map((entry) => <option key={entry}>{entry}</option>)}</select></label></div>
        <label className="toggle-row"><span><Zap size={15}/>Fast Draft</span><button aria-pressed={draft} className={draft ? "toggle on" : "toggle"} disabled={Boolean(plan)} onClick={() => setDraft((value) => !value)} type="button"><i/></button></label>
      </div>
      <div className="estimate-lines"><div><span>Estimated shots</span><strong>{estimate.shots} shots</strong></div><div><span>Video generation</span><strong>${estimate.videoUsd.toFixed(2)}</strong></div><div><span>Audio</span><strong>${estimate.audioUsd.toFixed(2)}</strong></div><div><span>Retries reserve</span><strong>${estimate.retriesReserveUsd.toFixed(2)}</strong></div><div className="budget-line"><span>Maximum budget</span><label>$<input aria-label="Maximum generation budget" min="0" onChange={(event) => setBudget(Math.max(0, Number(event.target.value) || 0))} type="number" value={budget}/></label></div></div>
      <Button className="plan-button" disabled={Boolean(plan) || prompt.trim().length < 10 || busy !== null} loading={busy === "planning"} onClick={() => void createPlan()} variant="primary">{plan ? "Movie plan saved" : "Plan movie"}<Clapperboard size={16}/></Button>
      <p className="approx-note">Estimate is approximate. Paid video jobs start only after the separate confirmation.</p>
    </section>

    <section className="preview-panel" aria-label="Movie preview">
      <div className="preview-frame">{selectedPreview ? <video controls key={selectedPreview.url} ref={videoRef} src={selectedPreview.url}/> : <div className="preview-empty"><Film size={36}/><strong>{selectedScene ? "Shot not generated yet" : "No planned scene selected"}</strong><span>{selectedScene ? "Its real media appears after a completed checkpoint." : "Plan a movie to build the Scene Graph."}</span></div>}{selectedScene ? <div className="preview-corner"><span>SCENE {selectedScene.number}</span><strong>{selectedScene.title}</strong></div> : null}</div>
      <div className="transport"><strong>{selectedScene ? formatTimecode(sceneStart(scenes, selectedScene.id)) : "00:00:00"}</strong><span className="fit-control">{selectedPreview ? `Shot ${selectedPreview.shot_id} · v${selectedPreview.version}` : "No media"}</span><div className="transport-center"><button aria-label="Previous scene" disabled={!selectedScene || scenes[0]?.id === selectedScene.id} onClick={() => selectRelative(-1)} type="button"><Play size={17} style={{ transform: "rotate(180deg)" }}/></button>{selectedPreview ? <button aria-label="Play or pause" className="play-control" onClick={() => void togglePreview()} type="button"><Play size={21} fill="currentColor"/></button> : null}<button aria-label="Next scene" disabled={!selectedScene || scenes.at(-1)?.id === selectedScene.id} onClick={() => selectRelative(1)} type="button"><Play size={17}/></button></div><div className="transport-actions">{selectedPreview ? <button aria-label="Fullscreen preview" onClick={() => void openFullscreen()} type="button"><Expand size={17}/></button> : null}</div></div>
      <div className="seek-line"><i style={{ width: `${progress}%` }}/><b style={{ left: `${progress}%` }}/></div>
    </section>

    <aside className="production-panel"><div className="panel-tabs">{(["overview","scenes","memory"] as const).map((tab) => <button className={rightTab === tab ? "active" : ""} key={tab} onClick={() => setRightTab(tab)} type="button">{tab[0].toUpperCase()+tab.slice(1)}</button>)}</div>{rightTab === "overview" ? <ProductionOverview detail={detail} onShowScenes={() => setRightTab("scenes")} selectedSceneId={selectedScene?.id ?? ""} setSelectedSceneId={setSelectedSceneId}/> : null}{rightTab === "scenes" ? <SceneList scenes={scenes} selectedSceneId={selectedScene?.id ?? ""} setSelectedSceneId={setSelectedSceneId}/> : null}{rightTab === "memory" ? <MemorySummary plan={plan}/> : null}</aside>

    <section className="timeline-panel" aria-label="Movie timeline"><div className="timeline-toolbar"><div><strong>MASTER TIMELINE</strong></div><strong className="timeline-time">{selectedScene ? formatTimecode(sceneStart(scenes, selectedScene.id)) : "00:00:00"} / {formatTimecode(duration)}</strong><div><button aria-label="Zoom out" onClick={() => setTimelineZoom((value) => Math.max(50,value-25))} type="button"><ZoomOut size={15}/></button><input aria-label="Timeline zoom" max="250" min="50" onChange={(event) => setTimelineZoom(Number(event.target.value))} type="range" value={timelineZoom}/><button aria-label="Zoom in" onClick={() => setTimelineZoom((value) => Math.min(250,value+25))} type="button"><ZoomIn size={15}/></button></div></div><div className="time-ruler">{[0,.2,.4,.6,.8,1].map((ratio) => <span key={ratio}>{formatTimecode(duration*ratio)}</span>)}</div><div className="tracks" style={{ minWidth: `${timelineZoom}%` }}><div className="playhead" style={{ left: `${selectedScene && duration ? sceneStart(scenes,selectedScene.id)/duration*100 : 0}%` }}><i/></div>{tracks.map((track) => <TimelineTrack key={track.label} track={track} selectedSceneId={selectedScene?.id ?? ""} setSelectedSceneId={setSelectedSceneId}/>)}</div></section>

    {budgetOpen && plan ? <BudgetConfirmation budget={budget} estimate={estimate} modelName={model.displayName} onClose={() => setBudgetOpen(false)} onConfirm={() => void confirmGeneration()} busy={busy === "generating"} duration={duration} resolution={resolution} overBudget={costOverBudget}/> : planReady ? <div className="budget-collapsed"><Button onClick={() => setBudgetOpen(true)} variant="primary"><CircleDollarSign size={15}/>Review cost</Button></div> : null}

    <footer className="studio-statusbar"><div><Gauge size={15}/><span>Active queue</span><b>{activeJobs.length}</b></div><div className="status-progress"><span>{detail ? `${detail.project.status} · ${detail.project.completedShots}/${detail.project.totalShots} shots` : "No active production"}</span><i><b style={{ width: `${progress}%` }}/></i><strong>{progress}%</strong></div><div className="status-progress spend"><span>Project API spend</span><i><b style={{ width: `${detail?.project.maximumBudgetUsd ? Math.min(100,detail.project.spentUsd/detail.project.maximumBudgetUsd*100) : 0}%` }}/></i><strong>${Number(detail?.project.spentUsd ?? 0).toFixed(2)} / ${Number(detail?.project.maximumBudgetUsd ?? budget).toFixed(2)}</strong></div><div><StatusDot tone={detail?.project.status === "failed" ? "red" : detail?.project.status === "paused" ? "amber" : "teal"}/><span>{notice}</span></div><div><span>{resolution} · {aspectRatio}{latestCheckpoint ? ` · CP ${latestCheckpoint.sequence}` : ""}</span></div></footer>
  </div>;
}

function ProductionOverview({ detail, selectedSceneId, setSelectedSceneId, onShowScenes }: { detail: DetailPayload | null; selectedSceneId: string; setSelectedSceneId: (id: string) => void; onShowScenes: () => void }) {
  const plan = detail?.plan; const status = detail?.project.status; const jobs = detail?.jobs ?? []; const checkpoints = detail?.checkpoints ?? [];
  const stages = [
    ["Story", plan ? "complete" : "waiting"], ["Characters", plan?.characters.length ? "complete" : "waiting"], ["Storyboard", plan?.scenes.length ? "complete" : "waiting"],
    ["Scene generation", ["queued","generating"].includes(status ?? "") ? "active" : status === "completed" ? "complete" : "waiting"],
    ["Continuity", jobs.some((job) => job.state === "validating") ? "active" : status === "completed" ? "complete" : "waiting"],
    ["Assembly", status === "assembling" ? "active" : status === "completed" ? "complete" : "waiting"], ["Final QC", status === "completed" ? "complete" : "waiting"],
  ];
  return <div className="production-content"><h2>Production stages</h2><div className="stage-list">{stages.map(([name,state]) => <div key={name}><span className={`stage-icon ${state}`}>{state === "complete" ? <Check size={12}/> : state === "active" ? <span/> : <Square size={10}/>}</span><strong>{name}</strong><em>{state === "active" ? "In progress" : state === "complete" ? "Ready" : "Waiting"}</em></div>)}</div><div className="score-card"><span>Project state</span><div><Lightbulb size={20}/><p>{detail ? `${detail.project.completedShots} completed · ${detail.project.totalShots-detail.project.completedShots} pending` : "Plan the movie first"}<br/><small>{jobs.filter((job) => job.state === "failed").length} failed jobs</small></p></div></div><div className="checkpoint-card"><div><span>Persistent checkpoints</span></div><p><Check size={13}/>{checkpoints.length ? `${checkpoints.length} recent checkpoints loaded; latest sequence ${checkpoints[0].sequence}` : "No shot checkpoint has been written yet"}</p></div><h2>Scenes</h2><div className="scene-strip">{(plan?.scenes ?? []).slice(0,4).map((scene) => <button className={selectedSceneId === scene.id ? "selected" : ""} key={scene.id} onClick={() => setSelectedSceneId(scene.id)} type="button"><span className="resource-placeholder"><Film size={16}/></span><strong>Scene {scene.number}</strong><small>{formatTimecode(scene.durationSeconds)}</small></button>)}</div>{(plan?.scenes.length ?? 0) > 4 ? <Button className="wide-inline" onClick={onShowScenes} variant="ghost">Open all {plan?.scenes.length} scenes</Button> : null}</div>;
}
function SceneList({ scenes, selectedSceneId, setSelectedSceneId }: { scenes: Scene[]; selectedSceneId: string; setSelectedSceneId: (id: string) => void }) { return <div className="production-content"><h2>Scene graph</h2><div className="inspector-list">{scenes.map((scene) => <button className={selectedSceneId === scene.id ? "selected" : ""} key={scene.id} onClick={() => setSelectedSceneId(scene.id)} type="button"><ListVideo size={15}/><span><strong>Scene {scene.number}</strong><small>{scene.title}</small></span><em>{formatTimecode(scene.durationSeconds)}</em></button>)}</div>{!scenes.length ? <p className="field-help">No screenplay has been planned.</p> : null}</div>; }
function MemorySummary({ plan }: { plan: MoviePlan | null | undefined }) { const facts = [...(plan?.characters ?? []).flatMap((character) => Object.entries(character.locks).filter(([,locked]) => locked).map(([key]) => `${character.name} · ${key}`)), ...(plan?.locations ?? []).filter((location) => location.designLocked).map((location) => `${location.name} · design`)]; return <div className="production-content"><h2>Locked project memory</h2><div className="memory-facts">{facts.map((fact) => <p key={fact}><Lock size={13}/>{fact}</p>)}{!facts.length ? <p>No continuity values are locked.</p> : null}</div><div className="score-card"><span>Context builder</span><div><Lightbulb size={20}/><p>{plan ? `${plan.characters.length} characters · ${plan.locations.length} locations` : "No Project Memory yet"}<br/><small>Only relevant scene context is sent per shot.</small></p></div></div></div>; }
function TimelineTrack({ track, selectedSceneId, setSelectedSceneId }: { track: Track; selectedSceneId: string; setSelectedSceneId: (id: string) => void }) { const Icon = track.icon; return <div className={`timeline-track tone-${track.tone}`}><div className="track-head"><Icon size={14}/><span>{track.label}</span><Eye size={13}/><Lock size={12}/></div><div className="track-clips">{track.clips.map((clip) => <button className={selectedSceneId === clip.sceneId ? "selected" : ""} key={clip.id} onClick={() => setSelectedSceneId(clip.sceneId)} style={{ flexGrow: Math.max(.5,clip.duration) }} type="button"><span>{clip.label}</span></button>)}</div></div>; }
function BudgetConfirmation({ estimate, budget, modelName, duration, resolution, onClose, onConfirm, busy, overBudget }: { estimate: ReturnType<typeof estimateGeneration>; budget: number; modelName: string; duration: number; resolution: Resolution; onClose: () => void; onConfirm: () => void; busy: boolean; overBudget: boolean }) { return <div className="budget-confirm"><div className="budget-title"><strong>Confirm paid generation</strong><button aria-label="Close cost confirmation" onClick={onClose} type="button"><X size={15}/></button></div><dl><div><dt>Model</dt><dd>{modelName}</dd></div><div><dt>Movie</dt><dd>{formatDuration(duration)} · {resolution}</dd></div><div><dt>Planned generations</dt><dd>{estimate.shots}</dd></div><div><dt>Video</dt><dd>${estimate.videoUsd.toFixed(2)}</dd></div><div><dt>Audio</dt><dd>${estimate.audioUsd.toFixed(2)}</dd></div><div><dt>Retry reserve</dt><dd>${estimate.retriesReserveUsd.toFixed(2)}</dd></div></dl><div className="cost-total"><span>Approximate total</span><strong>${estimate.estimatedTotalUsd.toFixed(2)}</strong></div><Button disabled={overBudget} loading={busy} onClick={onConfirm} variant="primary">{overBudget ? `Increase $${budget.toFixed(2)} budget` : `Confirm & generate · max $${budget.toFixed(2)}`}</Button><p>No provider call starts until confirmation. Generation pauses instead of exceeding the project budget.</p></div>; }
function buildTracks(scenes: Scene[]): Track[] { const shotRows = scenes.flatMap((scene) => scene.shots.map((shot) => ({ scene, shot }))); return [
  { label: "Video", icon: Film, tone: "video", clips: shotRows.map(({scene,shot}) => ({ id: `v:${shot.id}`, sceneId: scene.id, label: shot.title, duration: shot.durationSeconds })) },
  { label: "Dialogue", icon: MessageSquareText, tone: "dialogue", clips: shotRows.map(({scene,shot}) => ({ id: `d:${shot.id}`, sceneId: scene.id, label: shot.audioContext.dialogue.map((line) => `${line.characterName}: ${line.text}`).join(" · ") || "No dialogue", duration: shot.durationSeconds })) },
  { label: "Music", icon: Music2, tone: "music", clips: shotRows.map(({scene,shot}) => ({ id: `m:${shot.id}`, sceneId: scene.id, label: shot.audioContext.musicCue ?? "No music", duration: shot.durationSeconds })) },
  { label: "SFX", icon: Volume2, tone: "sfx", clips: shotRows.map(({scene,shot}) => ({ id: `s:${shot.id}`, sceneId: scene.id, label: shot.audioContext.soundEffects.join(", ") || "No SFX", duration: shot.durationSeconds })) },
  { label: "Ambience", icon: Waves, tone: "ambience", clips: shotRows.map(({scene,shot}) => ({ id: `a:${shot.id}`, sceneId: scene.id, label: shot.audioContext.ambience.join(", ") || "No ambience", duration: shot.durationSeconds })) },
  { label: "Subtitles", icon: Subtitles, tone: "subtitles", clips: shotRows.map(({scene,shot}) => ({ id: `t:${shot.id}`, sceneId: scene.id, label: shot.audioContext.dialogue.map((line) => line.text).join(" · ") || "No subtitles", duration: shot.durationSeconds })) },
]; }
function sceneStart(scenes: Scene[], sceneId: string) { let cursor = 0; for (const scene of scenes) { if (scene.id === sceneId) return cursor; cursor += scene.durationSeconds; } return 0; }
function formatTimecode(seconds: number) { const value = Math.max(0,Math.floor(seconds)); const hours = Math.floor(value/3600); const minutes = Math.floor(value%3600/60); const secs = value%60; return `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(secs).padStart(2,"0")}`; }
