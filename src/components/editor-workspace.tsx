"use client";

import Image from "next/image";
import { useState } from "react";
import { Check, ChevronDown, Download, Film, Lock, MessageSquareText, Music2, Play, Send, Subtitles, Volume2, Waves } from "lucide-react";
import { Button, PanelHeading } from "./ui";

const editScenes = [
  ["Scene 11", "Cold trail", "/assets/glass-horizon-street.png"],
  ["Scene 12", "Interrogation", "/assets/glass-horizon-interrogation.png"],
  ["Scene 13", "Rooftop witness", "/assets/glass-horizon-rooftop.png"],
  ["Scene 14", "The choice", "/assets/glass-horizon-rooftop.png"],
];
const editorTracks = [
  { label: "Video", icon: Film, tone: "video", clips: ["S11 · v1", "S12 · v3", "S13 · v2", "S14 · v1"] },
  { label: "Dialogue", icon: MessageSquareText, tone: "dialogue", clips: ["I followed the signal.", "You were never meant…", "Tell me where he is.", "The city chooses."] },
  { label: "Music", icon: Music2, tone: "music", clips: ["Tension bed", "Rooftop rise"] },
  { label: "SFX", icon: Volume2, tone: "sfx", clips: ["Traffic", "Door", "Wind", "Footstep", "Drive click"] },
  { label: "Ambience", icon: Waves, tone: "ambience", clips: ["Winter street", "Room tone", "Rooftop wind"] },
  { label: "Subtitles", icon: Subtitles, tone: "subtitles", clips: ["I followed…", "You were…", "Tell me…", "The city…"] },
];

export function EditorWorkspace() {
  const [selected, setSelected] = useState(2);
  const [command, setCommand] = useState("At 08:14 make Elias deliver the line more calmly. Keep the video unchanged.");
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editNotice, setEditNotice] = useState("");
  const scene = editScenes[selected];
  async function applyMinimalEdit() {
    const projectId = localStorage.getItem("cineforge.projectId");
    if (!projectId) { setEditNotice("Create or open a persisted Movie Project before applying media edits."); return; }
    setBusy(true); setEditNotice("Running impact analysis…");
    try {
      const response = await fetch(`/api/projects/${projectId}/edits`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to apply edit.");
      setApplied(true);
      setEditNotice(payload.videoFramesPreserved ? "Dialogue version queued; original video frames will be stream-copied." : "Only the affected shot was queued for regeneration.");
    } catch (error) { setEditNotice(error instanceof Error ? error.message : "Edit failed."); }
    finally { setBusy(false); }
  }
  async function queueExport() {
    const projectId = localStorage.getItem("cineforge.projectId");
    if (!projectId) { setEditNotice("Create or open a persisted Movie Project before exporting."); return; }
    setBusy(true); setEditNotice("Queueing final MP4 assembly and QC…");
    try {
      const response = await fetch(`/api/projects/${projectId}/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "mp4", resolution: "720p" }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to queue export.");
      setEditNotice("Final MP4 assembly queued. The render remains recoverable from its latest checkpoint.");
    } catch (error) { setEditNotice(error instanceof Error ? error.message : "Export failed."); }
    finally { setBusy(false); }
  }
  return <div className="editor-grid">
    <aside className="editor-bin"><PanelHeading action={<button style={{ border: 0, background: "transparent", color: "var(--muted)" }}>+</button>}>Scenes · 24</PanelHeading><div className="bin-scenes">{editScenes.map((item,index) => <button className={`bin-scene ${selected === index ? "selected" : ""}`} key={item[0]} onClick={() => { setSelected(index); setApplied(false); }} type="button"><span className="bin-thumb"><Image alt="" fill sizes="60px" src={item[2]} /></span><span><strong>{item[0]}</strong><small>{item[1]} · v{index === 1 ? "3" : index === 2 ? "2" : "1"}</small></span></button>)}</div><PanelHeading>Versions</PanelHeading><div className="memory-facts" style={{ padding: 8 }}><p><Check size={12} />v1 · Original generation</p><p><Check size={12} />v2 · Dialogue softened</p><p><Lock size={12} />v3 · Active edit</p></div></aside>
    <section className="editor-preview"><div className="preview-frame"><Image alt={`${scene[0]} preview`} fill priority sizes="55vw" src={scene[2]} /><div className="preview-corner"><span>{scene[0].toUpperCase()} · SHOT 03</span><strong>{scene[1]}</strong></div></div><div className="transport"><strong>00:08:14:06</strong><button className="fit-control" type="button">100%<ChevronDown size={13} /></button><div className="transport-center"><button className="play-control" type="button"><Play size={20} fill="currentColor" /></button></div><div className="transport-actions"><Button onClick={queueExport} variant="ghost"><Download size={14} />Export</Button></div></div></section>
    <aside className="edit-chat"><PanelHeading>Edit with AI</PanelHeading><div className="edit-chat-log"><div className="message assistant" style={{ gridTemplateColumns: "24px 1fr" }}><span className="message-avatar"><MessageSquareText size={12} /></span><div className="message-content"><p>I’ll find the smallest affected region before making any change.</p></div></div><div className="impact-box"><h3>Impact Analysis</h3><p><strong>Affected</strong><br/>{scene[0]} / Shot 3 / Dialogue segment 00:08:13.2–00:08:16.8</p><p><strong>Unchanged</strong><br/>Video stream, music, SFX, ambience, Scenes 1–11 and 13–24</p><p>{editNotice || (applied ? "✓ New version created for the affected region." : "No media is changed until you confirm this scoped edit.")}</p></div></div><div className="edit-composer"><textarea aria-label="Edit with AI" onChange={(event) => setCommand(event.target.value)} value={command} /><Button loading={busy} onClick={applyMinimalEdit} variant="primary"><Send size={13} />Analyze & apply minimal edit</Button></div></aside>
    <section className="editor-timeline"><div className="timeline-toolbar"><div><strong>TIMELINE</strong><button type="button">Master sequence<ChevronDown size={13} /></button></div><strong className="timeline-time">00:08:14:06</strong><div><Button variant="ghost">Snapping: on</Button></div></div><div className="time-ruler"><span>00:07:30</span><span>00:08:00</span><span>00:08:15</span><span>00:08:30</span><span>00:09:00</span></div><div className="tracks"><div className="playhead" style={{ left: "53%" }}><i /></div>{editorTracks.map((track, row) => { const Icon = track.icon; return <div className={`timeline-track tone-${track.tone}`} key={track.label}><div className="track-head"><Icon size={13}/><span>{track.label}</span><span/><Lock size={11}/></div><div className="track-clips">{track.clips.map((clip,index) => <button className={row < 2 && index === selected ? "selected" : ""} key={clip} style={{ flex: index % 2 ? 1.2 : 1 }} type="button">{row === 0 ? <span className="clip-image"><Image alt="" fill sizes="160px" src={editScenes[index % editScenes.length][2]} /></span> : null}<span>{clip}</span></button>)}</div></div>; })}</div></section>
  </div>;
}
