"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Film, Lock, MessageSquareText, Music2, Play, Send, Subtitles, Volume2, Waves } from "lucide-react";
import type { MoviePlan, ProjectRecord, Scene } from "@/domain/movie";
import { Button, PanelHeading, StatusDot } from "./ui";

type TimelineClip = { id: string; scene_id: string; shot_id: string; track: TrackName; start_seconds: string; duration_seconds: string; source_version: number; metadata: Record<string, unknown> };
type Version = { shot_id: string; version: number; reason: string; continuity_score: string | null; active: boolean; created_at: string };
type ProjectDetail = { project: ProjectRecord; plan: MoviePlan | null; timeline: TimelineClip[]; versions: Version[] };
type PreviewClip = { shot_id: string; scene_id: string; url: string; duration_seconds: string; continuity_score: string | null; version: number };
type PreviewPayload = { clips: PreviewClip[]; movieUrl: string | null };
type Impact = { intent: string; affected: Array<{ sceneId: string; shotId: string; dialogueIds: string[]; tracks: string[] }>; unaffected: { before: string[]; after: string[] }; requiresVideoRegeneration: boolean; reason: string };
type TrackName = "video" | "dialogue" | "music" | "sfx" | "ambience" | "subtitles";

const trackConfig: Record<TrackName, { label: string; icon: typeof Film; tone: string }> = {
  video: { label: "Video", icon: Film, tone: "video" }, dialogue: { label: "Dialogue", icon: MessageSquareText, tone: "dialogue" },
  music: { label: "Music", icon: Music2, tone: "music" }, sfx: { label: "SFX", icon: Volume2, tone: "sfx" },
  ambience: { label: "Ambience", icon: Waves, tone: "ambience" }, subtitles: { label: "Subtitles", icon: Subtitles, tone: "subtitles" },
};
const trackOrder = Object.keys(trackConfig) as TrackName[];

export function EditorWorkspace() {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [preview, setPreview] = useState<PreviewPayload>({ clips: [], movieUrl: null });
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [command, setCommand] = useState("");
  const [impact, setImpact] = useState<Impact | null>(null);
  const [busy, setBusy] = useState<"edit" | "export" | null>(null);
  const [notice, setNotice] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  const load = useCallback(async () => {
    const queryId = new URL(window.location.href).searchParams.get("project");
    const projectId = queryId ?? localStorage.getItem("cineforge.projectId");
    if (!projectId) { setNotice("Open or create a Movie Project first."); return; }
    localStorage.setItem("cineforge.projectId", projectId);
    try {
      const [detailResponse, previewResponse] = await Promise.all([
        fetch(`/api/projects?id=${encodeURIComponent(projectId)}`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/preview`, { cache: "no-store" }),
      ]);
      const detailPayload = await detailResponse.json();
      if (!detailResponse.ok || detailPayload.infrastructure === "offline") throw new Error(detailPayload.error ?? "Project infrastructure is offline.");
      setDetail(detailPayload);
      setSelectedSceneId((current) => current || detailPayload.plan?.scenes?.[0]?.id || "");
      if (previewResponse.ok) setPreview(await previewResponse.json());
      else setPreview({ clips: [], movieUrl: null });
      setNotice("");
    } catch (error) { setDetail(null); setNotice(error instanceof Error ? error.message : "Unable to load the project."); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const scenes = detail?.plan?.scenes ?? [];
  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? scenes[0];
  const selectedPreview = preview.clips.find((clip) => clip.scene_id === selectedScene?.id) ?? null;
  const versions = detail?.versions.filter((version) => selectedScene?.shots.some((shot) => shot.id === version.shot_id)) ?? [];
  const selectedStart = Number(detail?.timeline.find((clip) => clip.scene_id === selectedScene?.id)?.start_seconds ?? 0);
  const totalDuration = detail?.project.durationSeconds ?? 0;
  const canExport = Boolean(detail?.project.totalShots && detail.project.completedShots >= detail.project.totalShots);
  const tracks = useMemo(() => trackOrder.map((name) => ({ ...trackConfig[name], name, clips: (detail?.timeline ?? []).filter((clip) => clip.track === name) })), [detail]);

  async function applyMinimalEdit() {
    const projectId = detail?.project.id;
    if (!projectId || !command.trim()) { setNotice("Enter an edit command for the active project."); return; }
    setBusy("edit"); setImpact(null); setNotice("Running impact analysis…");
    try {
      const response = await fetch(`/api/projects/${projectId}/edits`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Unable to apply edit.");
      setImpact(payload.impact);
      setNotice(payload.videoFramesPreserved ? "Dialogue patch queued; original video frames are preserved." : "Only the affected shot was queued for regeneration.");
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Edit failed."); }
    finally { setBusy(null); }
  }

  async function queueExport() {
    const project = detail?.project; if (!project || !canExport) { setNotice("Export becomes available after every planned shot has a completed checkpoint."); return; }
    setBusy("export"); setNotice("Queueing final MP4 assembly and QC…");
    try {
      const resolution = project.resolution === "preview" ? "720p" : project.resolution;
      const response = await fetch(`/api/projects/${project.id}/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "mp4", resolution }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Unable to queue export.");
      setNotice("Final MP4 assembly queued. Its state is available in Renders.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Export failed."); }
    finally { setBusy(null); }
  }

  if (!detail?.plan) return <div className="empty-state editor-empty"><div><Film size={30}/><h2>{notice || "No editable screenplay"}</h2><p>The editor only shows persisted scenes, generated assets and versions. Create or open a planned Movie Project.</p><a className="button button-primary" href="/projects">Open Projects</a></div></div>;

  return <div className="editor-grid">
    <aside className="editor-bin"><PanelHeading>Scenes · {scenes.length}</PanelHeading><div className="bin-scenes">{scenes.map((scene) => <SceneButton key={scene.id} scene={scene} selected={selectedScene?.id === scene.id} versionCount={detail.versions.filter((version) => scene.shots.some((shot) => shot.id === version.shot_id)).length} onClick={() => { setSelectedSceneId(scene.id); setImpact(null); }}/>)}</div><PanelHeading>Versions</PanelHeading><div className="memory-facts" style={{ padding: 8 }}>{versions.length ? versions.map((version) => <p key={`${version.shot_id}:${version.version}`}>{version.active ? <Lock size={12}/> : <Check size={12}/>} {version.shot_id} · v{version.version} · {version.reason}{version.continuity_score ? ` · QC ${Number(version.continuity_score).toFixed(0)}` : ""}</p>) : <p>No generated versions for this scene.</p>}</div></aside>
    <section className="editor-preview"><div className="preview-frame">{selectedPreview ? <video controls key={selectedPreview.url} ref={videoRef} src={selectedPreview.url}/> : <div className="preview-empty"><Film size={34}/><strong>Shot not generated yet</strong><span>The real preview appears after its first completed checkpoint.</span></div>}<div className="preview-corner"><span>SCENE {selectedScene.number}</span><strong>{selectedScene.title}</strong></div></div><div className="transport"><strong>{formatTimecode(selectedStart)}</strong><span className="fit-control">{selectedPreview ? `v${selectedPreview.version}` : "No media"}</span><div className="transport-center">{selectedPreview ? <button aria-label="Play or pause preview" className="play-control" onClick={() => videoRef.current?.paused ? void videoRef.current.play() : videoRef.current?.pause()} type="button"><Play size={20} fill="currentColor"/></button> : null}</div><div className="transport-actions"><Button disabled={!canExport} loading={busy === "export"} onClick={() => void queueExport()} variant="ghost"><Download size={14}/>Export</Button></div></div></section>
    <aside className="edit-chat"><PanelHeading>Edit with AI</PanelHeading><div className="edit-chat-log"><div className="message assistant" style={{ gridTemplateColumns: "24px 1fr" }}><span className="message-avatar"><MessageSquareText size={12}/></span><div className="message-content"><p>Describe the change with a timestamp or scene number. CineForge will compute the minimum affected region before queueing work.</p></div></div>{impact ? <div className="impact-box"><h3>Impact Analysis · {impact.intent}</h3><p><strong>Affected</strong><br/>{impact.affected.map((item) => `${item.sceneId} / ${item.shotId} / ${item.tracks.join(", ")}`).join("; ")}</p><p><strong>Unchanged</strong><br/>{impact.unaffected.before.length + impact.unaffected.after.length} shots remain on their existing versions.</p><p>{impact.reason}</p></div> : null}{notice ? <div className="secure-note" style={{ marginTop: 10 }}><StatusDot tone={notice.toLowerCase().includes("failed") ? "red" : "teal"}/>{notice}</div> : null}</div><div className="edit-composer"><textarea aria-label="Edit with AI" onChange={(event) => setCommand(event.target.value)} placeholder="Example: In Scene 4, replace the dialogue line and keep the video unchanged." value={command}/><Button disabled={!command.trim()} loading={busy === "edit"} onClick={() => void applyMinimalEdit()} variant="primary"><Send size={13}/>Analyze & apply minimal edit</Button></div></aside>
    <section className="editor-timeline"><div className="timeline-toolbar"><div><strong>MASTER TIMELINE</strong></div><strong className="timeline-time">{formatTimecode(selectedStart)} / {formatTimecode(totalDuration)}</strong><div><span className="field-help">Persisted clips only</span></div></div><div className="time-ruler">{[0,.25,.5,.75,1].map((ratio) => <span key={ratio}>{formatTimecode(totalDuration * ratio)}</span>)}</div><div className="tracks"><div className="playhead" style={{ left: `${Math.max(0, Math.min(100, totalDuration ? selectedStart / totalDuration * 100 : 0))}%` }}><i/></div>{tracks.map((track) => { const Icon = track.icon; return <div className={`timeline-track tone-${track.tone}`} key={track.name}><div className="track-head"><Icon size={13}/><span>{track.label}</span><span/><Lock size={11}/></div><div className="track-clips">{track.clips.map((clip) => <button className={clip.scene_id === selectedScene?.id ? "selected" : ""} key={clip.id} onClick={() => setSelectedSceneId(clip.scene_id)} style={{ flexGrow: Math.max(.5, Number(clip.duration_seconds)) }} type="button"><span>{clipLabel(track.name, clip)}</span></button>)}</div></div>; })}</div></section>
  </div>;
}

function SceneButton({ scene, selected, versionCount, onClick }: { scene: Scene; selected: boolean; versionCount: number; onClick: () => void }) { return <button className={`bin-scene ${selected ? "selected" : ""}`} onClick={onClick} type="button"><span className="bin-thumb resource-placeholder"><Film size={16}/></span><span><strong>Scene {scene.number} · {scene.title}</strong><small>{formatTimecode(scene.durationSeconds)} · {scene.shots.length} shots · {versionCount} versions</small></span></button>; }
function formatTimecode(seconds: number) { const value = Math.max(0, Math.floor(seconds)); const hours = Math.floor(value / 3600); const minutes = Math.floor(value % 3600 / 60); const secs = value % 60; return `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(secs).padStart(2,"0")}`; }
function clipLabel(track: TrackName, clip: TimelineClip) { const metadata = clip.metadata ?? {}; if (track === "video") return String(metadata.title ?? clip.shot_id); if (track === "music") return String(metadata.cue ?? "No music cue"); if (track === "sfx") return Array.isArray(metadata.effects) ? metadata.effects.join(", ") || "No SFX" : "SFX"; if (track === "ambience") return Array.isArray(metadata.ambience) ? metadata.ambience.join(", ") || "No ambience" : "Ambience"; if (track === "dialogue") { const dialogue = metadata.dialogue as Array<{ text?: string }> | undefined; return dialogue?.map((item) => item.text).filter(Boolean).join(" · ") || "No dialogue"; } if (track === "subtitles") { const lines = metadata.lines as Array<{ text?: string }> | undefined; return lines?.map((item) => item.text).filter(Boolean).join(" · ") || "No subtitles"; } return clip.shot_id; }
