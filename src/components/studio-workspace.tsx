"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import {
  Aperture,
  AudioLines,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clapperboard,
  Expand,
  Eye,
  Film,
  Gauge,
  ImageIcon,
  Lightbulb,
  ListVideo,
  Lock,
  Maximize,
  MessageSquareText,
  Music2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Subtitles,
  Volume2,
  Waves,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { estimateGeneration, formatDuration } from "@/domain/estimation";
import { GOOGLE_VIDEO_MODELS, normalizeResolution, type Resolution } from "@/domain/video-models";
import { Button, Segmented, StatusDot } from "./ui";

const sceneImages = [
  "/assets/glass-horizon-interrogation.png",
  "/assets/glass-horizon-street.png",
  "/assets/glass-horizon-rooftop.png",
];

const scenes = [
  { number: 10, title: "The interview", duration: "00:34", image: sceneImages[0] },
  { number: 11, title: "Cold trail", duration: "00:29", image: sceneImages[1] },
  { number: 12, title: "Street signal", duration: "00:36", image: sceneImages[1] },
  { number: 13, title: "Rooftop witness", duration: "00:41", image: sceneImages[2] },
];

const tracks = [
  { label: "Video", icon: Film, tone: "video", clips: ["Scene 8", "Scene 9", "Scene 10", "Scene 11", "Scene 12", "Scene 13", "Scene 14", "Scene 15"] },
  { label: "Dialogue", icon: MessageSquareText, tone: "dialogue", clips: ["DETECTIVE: You said…", "WITNESS: I only…", "DETECTIVE: Where were…", "MOGUL: This city…", "DETECTIVE: It all ends…"] },
  { label: "Music", icon: Music2, tone: "music", clips: ["Noir Pulse", "Tension Rise", "Resolution Theme"] },
  { label: "SFX", icon: Volume2, tone: "sfx", clips: ["Footsteps", "Door creak", "Phone ring", "Car door", "Glass break", "Distant siren"] },
  { label: "Ambience", icon: Waves, tone: "ambience", clips: ["NYC winter night ambience", "Interior room tone", "Alleyway wind", "Street ambience"] },
  { label: "Subtitles", icon: Subtitles, tone: "subtitles", clips: ["You think I don't see…", "I just want the truth.", "Everything comes…", "It all ends tonight."] },
];

export function StudioWorkspace() {
  const [mode, setMode] = useState<"quick" | "advanced">("advanced");
  const [prompt, setPrompt] = useState("A gritty detective film set in winter New York City. A world-weary investigative journalist uncovers a web of corruption tied to a powerful real estate mogul. Mood is noir, realistic, and grounded. Snow falls lightly on rain-slick streets. Include tense interrogations, shadowy alleyways, and stunning cityscapes. End with a moral choice that changes everything.");
  const [duration, setDuration] = useState(1_200);
  const [customDuration, setCustomDuration] = useState(false);
  const [modelId, setModelId] = useState("gemini-omni-flash-preview");
  const [resolution, setResolution] = useState<Resolution>("720p");
  const [draft, setDraft] = useState(true);
  const [budget, setBudget] = useState(25);
  const [selectedScene, setSelectedScene] = useState(12);
  const [playing, setPlaying] = useState(false);
  const [rightTab, setRightTab] = useState<"overview" | "scenes" | "memory">("overview");
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [planReady, setPlanReady] = useState(false);
  const [productionStarted, setProductionStarted] = useState(false);
  const [queuedJobs, setQueuedJobs] = useState(0);
  const [busy, setBusy] = useState<"planning" | "generating" | null>(null);
  const [notice, setNotice] = useState("Preview ready");
  const [accountModelIds, setAccountModelIds] = useState<Set<string> | null>(null);

  const model = GOOGLE_VIDEO_MODELS[modelId];
  const estimate = useMemo(() => estimateGeneration({ durationSeconds: duration, modelId, resolution }), [duration, modelId, resolution]);
  const previewImage = scenes.find((scene) => scene.number === selectedScene)?.image ?? sceneImages[1];

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const preparedRaw = sessionStorage.getItem("cineforge.preparedProject");
      if (preparedRaw) {
        try {
          const prepared = JSON.parse(preparedRaw) as { durationSeconds: number; modelId: string; resolution: Resolution; shots: number };
          if (GOOGLE_VIDEO_MODELS[prepared.modelId]) {
            setDuration(prepared.durationSeconds);
            setModelId(prepared.modelId);
            setResolution(normalizeResolution(prepared.modelId, prepared.resolution));
            setPlanReady(true);
            setBudgetOpen(true);
            setNotice(`${prepared.shots} shots prepared by AI Screenwriter`);
          }
        } catch { sessionStorage.removeItem("cineforge.preparedProject"); }
      }
      try {
        const response = await fetch("/api/models/google", { cache: "no-store" });
        const payload = await response.json();
        if (!payload.connected) return;
        const available = new Set<string>((payload.models ?? []).filter((entry: { available?: boolean; selectable?: boolean }) => entry.available && entry.selectable !== false).map((entry: { id: string }) => entry.id));
        setAccountModelIds(available);
        if (available.size) setModelId((current) => {
          if (available.has(current)) return current;
          const next = [...available][0];
          setResolution((resolutionValue) => normalizeResolution(next, resolutionValue));
          return next;
        });
        if (!available.size) setNotice("No supported Google video model is enabled for this API project.");
      } catch { /* The registry remains visible until a key is connected. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function changeModel(nextId: string) {
    setModelId(nextId);
    setResolution((current) => normalizeResolution(nextId, current));
  }

  async function createPlan(): Promise<string | null> {
    setBusy("planning");
    setNotice("Planning story…");
    try {
      const created = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Glass Horizon",
          prompt,
          durationSeconds: duration,
          modelId,
          resolution,
          aspectRatio: "16:9",
          mode,
          renderTier: draft ? "draft" : "final",
          maximumBudgetUsd: budget,
        }),
      });
      const payload = await created.json();
      if (!created.ok) throw new Error(payload.error ?? "Unable to create project.");
      localStorage.setItem("cineforge.projectId", payload.projectId);
      setNotice("Creating screenplay and shot graph…");
      const planned = await fetch(`/api/projects/${payload.projectId}/plan`, { method: "POST" });
      const planPayload = await planned.json();
      if (!planned.ok) throw new Error(planPayload.error ?? "Unable to plan movie.");
      setPlanReady(true);
      setBudgetOpen(true);
      setNotice(`${planPayload.shots} shots planned`);
      return payload.projectId as string;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Planning failed");
      setPlanReady(false);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function confirmGeneration() {
    let projectId = localStorage.getItem("cineforge.projectId");
    if (!projectId) {
      projectId = await createPlan();
      if (!projectId) return;
    }
    setBusy("generating");
    setNotice("Queueing generation…");
    try {
      const response = await fetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, maximumBudgetUsd: budget }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to start generation.");
      setQueuedJobs(payload.queued);
      setProductionStarted(true);
      setNotice(`${payload.queued} generation jobs queued`);
      setBudgetOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Generation failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="studio-grid">
      <section className="brief-panel" aria-label="Movie brief">
        <div className="section-title"><h1>Describe your movie</h1><button aria-label="Collapse brief" type="button">«</button></div>
        <Segmented value={mode} onChange={setMode} options={[{ value: "quick", label: "Quick Create" }, { value: "advanced", label: "Advanced" }]} />
        <div className="prompt-box">
          <textarea aria-label="Describe your movie" maxLength={20_000} onChange={(event) => setPrompt(event.target.value)} value={prompt} />
          <span>{prompt.length} / 20,000</span>
        </div>
        <div className="control-stack">
          <label><span><Aperture size={15} />Duration</span><select onChange={(event) => { if (event.target.value === "custom") setCustomDuration(true); else { setCustomDuration(false); setDuration(Number(event.target.value)); } }} value={customDuration ? "custom" : duration}>
            {[10,30,60,180,300,600,900,1200,1800,2700,3600].map((seconds) => <option key={seconds} value={seconds}>{formatDuration(seconds)}</option>)}<option value="custom">Custom Duration…</option>
          </select></label>
          {customDuration ? <label><span>Seconds</span><input aria-label="Custom duration in seconds" max="3600" min="1" onChange={(event) => setDuration(Math.max(1, Math.min(3600, Number(event.target.value))))} type="number" value={duration} /></label> : null}
          <label><span><Sparkles size={15} />Model</span><select onChange={(event) => changeModel(event.target.value)} value={modelId}>
            {Object.values(GOOGLE_VIDEO_MODELS).map((entry) => <option disabled={accountModelIds !== null && !accountModelIds.has(entry.id)} key={entry.id} value={entry.id}>{entry.displayName}{accountModelIds !== null && !accountModelIds.has(entry.id) ? " · unavailable for this key" : ""}</option>)}
          </select></label>
          <div className="split-control">
            <label><span><ImageIcon size={15} />Resolution</span><select onChange={(event) => setResolution(event.target.value as Resolution)} value={resolution}>
              {model.resolutions.map((entry) => <option key={entry} value={entry}>{entry === "preview" ? "Preview / Draft" : entry}</option>)}
            </select></label>
            <label className="aspect"><span>Aspect</span><select defaultValue="16:9"><option>16:9</option><option>9:16</option></select></label>
          </div>
          <label className="toggle-row"><span><Zap size={15} />Fast Draft</span><button aria-pressed={draft} className={draft ? "toggle on" : "toggle"} onClick={() => setDraft((value) => !value)} type="button"><i /></button></label>
        </div>
        <div className="estimate-lines">
          <div><span>Estimated shots</span><strong>{estimate.shots} shots</strong></div>
          <div><span>Video generation</span><strong>${estimate.videoUsd.toFixed(2)}</strong></div>
          <div><span>Retries reserve</span><strong>${estimate.retriesReserveUsd.toFixed(2)}</strong></div>
          <div className="budget-line"><span>Maximum budget</span><label>$<input aria-label="Maximum generation budget" min="0" onChange={(event) => setBudget(Number(event.target.value))} type="number" value={budget} /></label></div>
        </div>
        <Button className="plan-button" loading={busy === "planning"} onClick={() => void createPlan()} variant="primary">Plan movie<Clapperboard size={16} /></Button>
        <p className="approx-note">Cost is approximate and based on current official per-second pricing.</p>
      </section>

      <section className="preview-panel" aria-label="Movie preview">
        <div className="preview-frame">
          <Image alt="Glass Horizon — selected scene preview" fill priority sizes="(max-width: 1200px) 60vw, 50vw" src={previewImage} />
          <div className="preview-corner"><span>SCENE {selectedScene}</span><strong>{scenes.find((scene) => scene.number === selectedScene)?.title}</strong></div>
        </div>
        <div className="transport">
          <strong>00:03:56:12</strong>
          <button className="fit-control" type="button">Fit<ChevronDown size={13} /></button>
          <div className="transport-center">
            <button aria-label="Previous scene" type="button"><RotateCcw size={17} /></button>
            <button aria-label={playing ? "Pause" : "Play"} className="play-control" onClick={() => setPlaying((value) => !value)} type="button">
              {playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}
            </button>
            <button aria-label="Next scene" type="button"><Play size={17} /></button>
          </div>
          <div className="transport-actions"><button aria-label="Capture frame" type="button"><Aperture size={17} /></button><button aria-label="Fullscreen" type="button"><Expand size={17} /></button></div>
        </div>
        <div className="seek-line"><i style={{ width: "37%" }} /><b style={{ left: "37%" }} /></div>
      </section>

      <aside className="production-panel">
        <div className="panel-tabs">
          {(["overview","scenes","memory"] as const).map((tab) => <button className={rightTab === tab ? "active" : ""} key={tab} onClick={() => setRightTab(tab)} type="button">{tab[0].toUpperCase()+tab.slice(1)}</button>)}
        </div>
        {rightTab === "overview" ? <ProductionOverview planReady={planReady} productionStarted={productionStarted} selectedScene={selectedScene} setSelectedScene={setSelectedScene} /> : null}
        {rightTab === "scenes" ? <SceneList selectedScene={selectedScene} setSelectedScene={setSelectedScene} /> : null}
        {rightTab === "memory" ? <MemorySummary /> : null}
      </aside>

      <section className="timeline-panel" aria-label="Movie timeline">
        <div className="timeline-toolbar">
          <div><strong>TIMELINE</strong><button type="button">Sequence 01<ChevronDown size={13} /></button><button aria-label="Add track" type="button">+</button></div>
          <strong className="timeline-time">00:03:56:12</strong>
          <div><button aria-label="Zoom out" type="button"><ZoomOut size={15} /></button><input aria-label="Timeline zoom" defaultValue="42" type="range" /><button aria-label="Zoom in" type="button"><ZoomIn size={15} /></button><button aria-label="Fit timeline" type="button"><Maximize size={15} /></button></div>
        </div>
        <div className="time-ruler"><span>00:00:00:00</span><span>00:01:00:00</span><span>00:02:00:00</span><span>00:03:00:00</span><span>00:05:00:00</span><span>00:09:00:00</span><span>00:11:00:00</span></div>
        <div className="tracks"><div className="playhead" style={{ left: "43.8%" }}><i /></div>{tracks.map((track, trackIndex) => <TimelineTrack key={track.label} track={track} selectedScene={selectedScene} setSelectedScene={setSelectedScene} trackIndex={trackIndex} />)}</div>
      </section>

      {budgetOpen ? <BudgetConfirmation budget={budget} estimate={estimate} modelName={model.displayName} onClose={() => setBudgetOpen(false)} onConfirm={confirmGeneration} busy={busy === "generating"} duration={duration} resolution={resolution} /> : planReady ? <div className="budget-collapsed"><Button onClick={() => setBudgetOpen(true)} variant="primary"><CircleDollarSign size={15} />Review cost</Button></div> : null}

      <footer className="studio-statusbar">
        <div><Gauge size={15} /><span>Background queue</span><b>{queuedJobs}</b></div>
        <div className="status-progress"><span>{productionStarted ? "Generation queued · checkpoints enabled" : planReady ? "Generation plan ready" : "No active generation"}</span><i><b style={{ width: productionStarted ? "4%" : "0%" }} /></i><strong>{productionStarted ? "Queued" : "Idle"}</strong></div>
        <div className="status-progress spend"><span>Project API spend</span><i><b style={{ width: "0%" }} /></i><strong>$0.00 / ${budget.toFixed(2)}</strong></div>
        <div><StatusDot /><span>{notice}</span></div>
        <div><span>720p · H.264</span><Button variant="ghost">Test playback</Button></div>
      </footer>
    </div>
  );
}

function ProductionOverview({ planReady, productionStarted, selectedScene, setSelectedScene }: { planReady: boolean; productionStarted: boolean; selectedScene: number; setSelectedScene: (scene: number) => void }) {
  const plannedStatus = planReady ? "complete" : "waiting";
  const stages = [
    ["Story", plannedStatus], ["Characters", plannedStatus], ["Storyboard", plannedStatus],
    ["Scene generation", productionStarted ? "active" : "waiting"], ["Continuity", "waiting"], ["Audio", "waiting"], ["Assembly", "waiting"], ["Final QC", "waiting"],
  ];
  return <div className="production-content">
    <h2>Production stages</h2>
    <div className="stage-list">{stages.map(([name,status]) => <div key={name}><span className={`stage-icon ${status}`}>{status === "complete" ? <Check size={12} /> : status === "active" ? <span /> : <Square size={10} />}</span><strong>{name}</strong><em>{status === "active" ? "Queued with dependency graph" : status === "complete" ? "" : "Waiting"}</em>{status === "active" ? <b>Ready</b> : null}</div>)}</div>
    <div className="score-card"><span>{productionStarted ? "Continuity validation" : "Project memory readiness"}</span><div><AudioLines size={24} /><strong>{planReady ? "Ready" : "—"}</strong><em>{planReady ? "Structured context" : "Plan the movie first"}</em><Button variant="ghost">Details</Button></div></div>
    <div className="checkpoint-card"><div><span>Checkpoints</span><Button variant="ghost">View all</Button></div><p><Check size={13} />{productionStarted ? "Enabled after every shot" : "Ready when generation starts"}</p></div>
    <h2>Recent scenes</h2>
    <div className="scene-strip">{scenes.map((scene) => <button className={selectedScene === scene.number ? "selected" : ""} key={scene.number} onClick={() => setSelectedScene(scene.number)} type="button"><span><Image alt="" fill sizes="100px" src={scene.image} /></span><strong>Scene {scene.number}</strong><small>{scene.duration}</small></button>)}</div>
  </div>;
}

function SceneList({ selectedScene, setSelectedScene }: { selectedScene: number; setSelectedScene: (scene: number) => void }) {
  return <div className="production-content"><h2>Scene graph</h2><div className="inspector-list">{scenes.map((scene) => <button className={selectedScene === scene.number ? "selected" : ""} key={scene.number} onClick={() => setSelectedScene(scene.number)} type="button"><ListVideo size={15} /><span><strong>Scene {scene.number}</strong><small>{scene.title}</small></span><em>{scene.duration}</em></button>)}</div></div>;
}

function MemorySummary() {
  return <div className="production-content"><h2>Locked project memory</h2><div className="memory-facts"><p><Lock size={13} />Elias · face and charcoal coat</p><p><Lock size={13} />Mara · voice identity</p><p><Lock size={13} />Apartment 4B · object layout</p><p><Lock size={13} />Evidence drive · silver</p></div><div className="score-card"><span>Context for next shot</span><div><Lightbulb size={20} /><p>8 relevant facts · 3 references<br/><small>Previous and next shot states included</small></p></div></div></div>;
}

function TimelineTrack({ track, trackIndex, selectedScene, setSelectedScene }: { track: typeof tracks[number]; trackIndex: number; selectedScene: number; setSelectedScene: (scene: number) => void }) {
  const Icon = track.icon;
  return <div className={`timeline-track tone-${track.tone}`}>
    <div className="track-head"><Icon size={14} /><span>{track.label}</span><Eye size={13} /><Lock size={12} /></div>
    <div className="track-clips">{track.clips.map((clip,index) => {
      const sceneNumber = 8 + index;
      const selected = trackIndex === 0 && sceneNumber === selectedScene;
      return <button className={selected ? "selected" : ""} key={`${clip}-${index}`} onClick={() => trackIndex === 0 && setSelectedScene(sceneNumber)} style={{ flex: index % 3 === 1 ? 1.25 : 1 }} type="button">
        {trackIndex === 0 ? <span className="clip-image"><Image alt="" fill sizes="150px" src={sceneImages[index % sceneImages.length]} /></span> : null}<span>{clip}</span>
      </button>;
    })}</div>
  </div>;
}

function BudgetConfirmation({ budget, estimate, modelName, onClose, onConfirm, busy, duration, resolution }: {
  budget: number; estimate: ReturnType<typeof estimateGeneration>; modelName: string; onClose: () => void; onConfirm: () => void; busy: boolean; duration: number; resolution: Resolution;
}) {
  return <aside className="budget-confirm">
    <div className="budget-title"><strong>Confirm budget</strong><button aria-label="Close cost confirmation" onClick={onClose} type="button"><X size={15} /></button></div>
    <dl><div><dt>Model</dt><dd>{modelName}</dd></div><div><dt>Duration</dt><dd>{formatDuration(duration)}</dd></div><div><dt>Resolution</dt><dd>{resolution} · 16:9</dd></div><div><dt>Estimated shots</dt><dd>{estimate.shots} shots</dd></div><div><dt>Maximum budget</dt><dd>${budget.toFixed(2)}</dd></div></dl>
    <div className="cost-total"><span>Approx. cost</span><strong>${estimate.estimatedTotalUsd.toFixed(2)} USD</strong></div>
    <Button disabled={estimate.estimatedTotalUsd > budget} loading={busy} onClick={onConfirm} variant="primary"><Lock size={14} />Confirm paid generation</Button>
    <p>{estimate.estimatedTotalUsd > budget ? `Increase the maximum budget to at least $${estimate.estimatedTotalUsd.toFixed(2)} before generation.` : "You will only be charged by providers for successful usage. The project pauses automatically at its budget."}</p>
  </aside>;
}
