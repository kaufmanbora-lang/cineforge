"use client";

import { useEffect, useState } from "react";
import { Bot, CheckCircle2, Database, Eye, EyeOff, KeyRound, LockKeyhole, ServerCog, ShieldCheck, Video } from "lucide-react";
import { Button, StatusDot } from "./ui";

type ProviderState = { configured: boolean; source: "vault" | "environment" | "none"; hint: string | null; status: string; lastCheckedAt: string | null };
type StatusPayload = { google: ProviderState & { models?: Array<{ id: string; displayName: string; resolutions: string[]; nativeAudio: boolean; selectable?: boolean }> }; openai: ProviderState & { taskModels?: Record<string,{ id: string; displayName: string }>; availableModels?: Array<{ id: string; displayName: string }>; routing?: Record<string,string> } };

export function SettingsWorkspace() {
  const [section, setSection] = useState("API");
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [googleKey, setGoogleKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [showGoogle, setShowGoogle] = useState(false);
  const [showOpenAI, setShowOpenAI] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState("");

  async function loadStatus() {
    const response = await fetch("/api/settings/status", { cache: "no-store" });
    if (response.ok) setStatus(await response.json());
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void loadStatus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function save(provider: "google" | "openai") {
    const key = provider === "google" ? googleKey : openaiKey;
    if (!key) return;
    setBusy(provider); setMessage("Testing connection…");
    try {
      const response = await fetch(`/api/settings/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Connection failed.");
      if (provider === "google") setGoogleKey("");
      else setOpenaiKey("");
      setMessage(`${provider === "google" ? "Google" : "OpenAI"} API key verified and stored server-side.`);
      await loadStatus();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Connection failed."); }
    finally { setBusy(undefined); }
  }

  async function test(provider: "google" | "openai") {
    setBusy(`test-${provider}`); setMessage("Testing connection…");
    try {
      const response = await fetch(`/api/settings/${provider}`, { method: "PUT" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Connection failed.");
      setMessage(`${provider === "google" ? "Google" : "OpenAI"} connection is healthy.`); await loadStatus();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Connection failed."); }
    finally { setBusy(undefined); }
  }

  async function saveRouting(task: string, modelId: string) {
    setBusy(`routing-${task}`); setMessage("Saving model routing…");
    try {
      const response = await fetch("/api/settings/openai", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task, modelId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to save model routing.");
      setMessage(`${task} now uses ${modelId}.`); await loadStatus();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save model routing."); }
    finally { setBusy(undefined); }
  }

  return <div className="page-frame">
    <div className="page-heading"><div><h1>Settings</h1><p>Provider credentials, task models, storage and production limits.</p></div>{message ? <div className="secure-note"><CheckCircle2 size={14} />{message}</div> : null}</div>
    <div className="settings-layout">
      <nav className="settings-nav">{[{label:"API",icon:KeyRound},{label:"AI Models",icon:Bot},{label:"Movie Engine",icon:ServerCog},{label:"Storage",icon:Database},{label:"Security",icon:ShieldCheck}].map(({label,icon:Icon}) => <button className={section === label ? "active" : ""} key={label} onClick={() => setSection(label)} type="button"><Icon size={14} />{label}</button>)}</nav>
      <div className="settings-content">
        {section === "API" ? <>
          <ProviderCard icon={<Video size={16} />} name="Google Gemini / Video API" description="Veo 3.1, Gemini Omni Flash and discovered Google video models" provider={status?.google}>
            <div className="form-row"><label htmlFor="google-key">API key</label><div><div className="field-group"><input autoComplete="off" id="google-key" onChange={(event) => setGoogleKey(event.target.value)} placeholder={status?.google.hint || "Enter GEMINI_API_KEY"} type={showGoogle ? "text" : "password"} value={googleKey} /><Button onClick={() => setShowGoogle((value) => !value)}>{showGoogle ? <EyeOff size={14} /> : <Eye size={14} />}</Button><Button loading={busy === "google"} onClick={() => save("google")} variant="primary">Save & test</Button></div><p className="field-help">After saving, this field is cleared. The full key is never returned to the browser.</p></div></div>
            <div className="form-row"><label>Connection</label><div><Button loading={busy === "test-google"} onClick={() => test("google")}>Test Connection</Button><p className="field-help">Remaining account quota is not exposed by Google&apos;s Models API; use Google AI Studio for active project limits.</p></div></div>
            <ModelTable models={status?.google.models ?? []} />
          </ProviderCard>
          <ProviderCard icon={<Bot size={16} />} name="OpenAI Responses API" description="ChatGPT screenwriter, prompt engineer and AI Director" provider={status?.openai}>
            <div className="form-row"><label htmlFor="openai-key">API key</label><div><div className="field-group"><input autoComplete="off" id="openai-key" onChange={(event) => setOpenaiKey(event.target.value)} placeholder={status?.openai.hint || "Enter OPENAI_API_KEY"} type={showOpenAI ? "text" : "password"} value={openaiKey} /><Button onClick={() => setShowOpenAI((value) => !value)}>{showOpenAI ? <EyeOff size={14} /> : <Eye size={14} />}</Button><Button loading={busy === "openai"} onClick={() => save("openai")} variant="primary">Save & test</Button></div><p className="field-help">Environment keys remain server-only. Stored keys are encrypted with AES-256-GCM.</p></div></div>
            <div className="form-row"><label>Connection</label><div><Button loading={busy === "test-openai"} onClick={() => test("openai")}>Test Connection</Button></div></div>
          </ProviderCard>
          <div className="secure-note"><LockKeyhole size={15} />Secrets are resolved only inside server routes and workers. No provider key is serialized into React props, API responses or the client bundle.</div>
        </> : null}
        {section === "AI Models" ? <ModelRouting available={status?.openai.availableModels ?? []} busy={busy} onChange={saveRouting} routing={status?.openai.routing ?? {}} /> : null}
        {section === "Movie Engine" ? <EngineSettings /> : null}
        {section === "Storage" ? <InfoCard title="Object storage"><p>Generated video, audio, reference frames and exports use S3-compatible object storage. PostgreSQL contains only metadata and signed object keys.</p><div className="form-row"><label>Bucket</label><input className="settings-select" defaultValue="cineforge" /></div></InfoCard> : null}
        {section === "Security" ? <InfoCard title="Security policy"><div className="memory-facts"><p><CheckCircle2 size={13} />Encrypted provider secrets</p><p><CheckCircle2 size={13} />Signed, expiring object URLs</p><p><CheckCircle2 size={13} />Validated request bodies</p><p><CheckCircle2 size={13} />Budget gates before paid generation</p></div></InfoCard> : null}
      </div>
    </div>
  </div>;
}

function ProviderCard({ icon, name, description, provider, children }: { icon: React.ReactNode; name: string; description: string; provider?: ProviderState; children: React.ReactNode }) { const connected = provider?.configured; return <section className="settings-card"><header className="settings-card-head"><span className="provider-mark">{icon}</span><div><h2>{name}</h2><p>{description}</p></div><span className="connection"><StatusDot tone={connected ? "green" : "red"} />{connected ? `Configured via ${provider?.source}` : "Not configured"}</span></header><div className="settings-card-body">{children}</div></section>; }
function ModelTable({ models }: { models: Array<{ id: string; displayName: string; resolutions: string[]; nativeAudio: boolean; selectable?: boolean }> }) { return <table className="model-table"><thead><tr><th>Available model</th><th>Resolution</th><th>Audio</th><th>Status</th></tr></thead><tbody>{models.map((model) => <tr key={model.id}><td><strong>{model.displayName}</strong><br/><span style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 8 }}>{model.id}</span></td><td>{model.resolutions.length ? model.resolutions.join(" · ") : "Unverified"}</td><td>{model.nativeAudio ? "Native" : model.selectable === false ? "Unverified" : "Separate"}</td><td><StatusDot tone={model.selectable === false ? "amber" : "green"} /> {model.selectable === false ? "Discovered" : "Adapter ready"}</td></tr>)}</tbody></table>; }
function ModelRouting({ available, routing, busy, onChange }: { available: Array<{ id: string; displayName: string }>; routing: Record<string,string>; busy?: string; onChange: (task: string, modelId: string) => Promise<void> }) { return <InfoCard title="OpenAI task routing"><p>Strong reasoning is reserved for story architecture; faster models handle prompts and high-volume quality checks. Selections are stored per workspace and resolved only on the server.</p>{["screenwriting","prompts","qc"].map((task) => <div className="form-row" key={task}><label>{task[0].toUpperCase()+task.slice(1)}</label><div className="field-group"><select className="settings-select" disabled={busy === `routing-${task}`} onChange={(event) => void onChange(task,event.target.value)} value={routing[task] ?? available[0]?.id}>{available.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.id}</option>)}</select></div></div>)}</InfoCard>; }
function EngineSettings() { return <InfoCard title="Movie Engine"><p>These limits control automatic retries and quality decisions. A failed shot never invalidates completed checkpoints.</p><div className="form-row"><label>QC retry below</label><input className="settings-select" defaultValue="75" type="number" /></div><div className="form-row"><label>Flag below</label><input className="settings-select" defaultValue="90" type="number" /></div><div className="form-row"><label>Automatic retries</label><input className="settings-select" defaultValue="2" max="5" type="number" /></div><div className="form-row"><label>Worker concurrency</label><input className="settings-select" defaultValue="2" max="16" type="number" /></div></InfoCard>; }
function InfoCard({ title, children }: { title: string; children: React.ReactNode }) { return <section className="settings-card"><header className="settings-card-head"><h2>{title}</h2></header><div className="settings-card-body" style={{ color: "var(--muted)", fontSize: 10, lineHeight: 1.6 }}>{children}</div></section>; }
