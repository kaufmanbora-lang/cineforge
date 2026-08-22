"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot, Check, Clipboard, Edit3, Film, ImagePlus, Lock, MessageSquareText, Paperclip,
  RefreshCw, Send, Sparkles, Square, User, WandSparkles,
} from "lucide-react";
import type { MoviePlan, ProjectRecord } from "@/domain/movie";
import { Button, Segmented, StatusDot } from "./ui";

type Message = { id: string; role: "user" | "assistant"; text: string; time: string };
type ProjectDetail = { project: ProjectRecord; plan: MoviePlan | null; memory?: { characters?: Array<{ locks: Record<string, boolean>; name: string }>; locations?: Array<{ locks: Record<string, boolean>; name: string }> } };

export function ScreenwriterWorkspace() {
  const router = useRouter();
  const [mode, setMode] = useState<"screenwriter" | "director">("screenwriter");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const [previousResponseId, setPreviousResponseId] = useState<string>();
  const [attachments, setAttachments] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState("");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadProject = useCallback(async (id: string) => {
    setConversationId(undefined); setPreviousResponseId(undefined); setMessages([]); setDetail(null);
    if (!id) return;
    localStorage.setItem("cineforge.projectId", id);
    try {
      const [detailResponse, historyResponse] = await Promise.all([
        fetch(`/api/projects?id=${encodeURIComponent(id)}`, { cache: "no-store" }),
        fetch(`/api/screenwriter/history?projectId=${encodeURIComponent(id)}`, { cache: "no-store" }),
      ]);
      const projectPayload = await detailResponse.json();
      if (!detailResponse.ok || projectPayload.infrastructure === "offline") throw new Error(projectPayload.error ?? "Project infrastructure is offline.");
      setDetail(projectPayload);
      if (historyResponse.ok) {
        const history = await historyResponse.json();
        if (Array.isArray(history.messages)) setMessages(history.messages.filter((message: { role: string }) => message.role === "user" || message.role === "assistant").map((message: { id: string; role: string; content?: { text?: string }; created_at?: string }) => ({
          id: message.id,
          role: message.role === "user" ? "user" : "assistant",
          text: message.content?.text ?? "",
          time: message.created_at ? new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Saved",
        })));
        setConversationId(history.conversations?.[0]?.id);
        setPreviousResponseId(history.conversations?.[0]?.last_response_id ?? undefined);
      }
      setNotice("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to load the project."); }
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => {
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/projects", { cache: "no-store" });
        const payload = await response.json();
        const rows = payload.infrastructure === "offline" || !Array.isArray(payload.projects) ? [] : payload.projects as ProjectRecord[];
        setProjects(rows);
        const queryId = new URL(window.location.href).searchParams.get("project");
        const stored = localStorage.getItem("cineforge.projectId");
        const selected = rows.find((item) => item.id === queryId)?.id ?? rows.find((item) => item.id === stored)?.id ?? rows[0]?.id ?? "";
        setProjectId(selected);
        if (selected) await loadProject(selected);
      } catch { setNotice("Project infrastructure is offline."); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadProject]);

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || streaming) return;
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", text, time: "Now" };
    const assistantId = crypto.randomUUID();
    setMessages((current) => [...current, userMessage, { id: assistantId, role: "assistant", text: "", time: "Now" }]);
    setInput(""); setStreaming(true); setNotice("");
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const response = await fetch("/api/screenwriter/chat", {
        method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, projectId: projectId || undefined, conversationId, previousResponseId, mode, attachments }),
      });
      if (!response.ok || !response.body) throw new Error((await response.json()).error ?? "AI Screenwriter is unavailable.");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const frames = buffer.split("\n\n"); buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = frame.match(/^event: (.+)$/m)?.[1]; const raw = frame.match(/^data: (.+)$/m)?.[1]; if (!raw) continue;
          const payload = JSON.parse(raw);
          if (event === "meta") setConversationId(payload.conversationId);
          if (event === "delta") setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, text: item.text + payload.delta } : item));
          if (event === "done") setPreviousResponseId(payload.responseId);
          if (event === "action" && payload.prepared?.projectId) {
            const preparedId = payload.prepared.projectId as string;
            localStorage.setItem("cineforge.projectId", preparedId); sessionStorage.setItem("cineforge.preparedProject", JSON.stringify(payload.prepared));
            setProjectId(preparedId); setNotice(`Movie Project “${payload.prepared.title}” is ready for cost confirmation.`);
            const projectResponse = await fetch(`/api/projects?id=${encodeURIComponent(preparedId)}`, { cache: "no-store" });
            if (projectResponse.ok) {
              const projectPayload = await projectResponse.json(); setDetail(projectPayload);
              setProjects((current) => current.some((item) => item.id === preparedId) ? current : [projectPayload.project, ...current]);
            }
          }
          if (event === "error") throw new Error(payload.error);
        }
      }
      setAttachments([]);
    } catch (error) {
      if ((error as Error).name !== "AbortError") setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, text: `I couldn’t complete that request: ${(error as Error).message}` } : item));
    } finally { setStreaming(false); abortRef.current = null; }
  }

  function chooseFiles(files: FileList | null) {
    if (!files) return;
    [...files].slice(0, 3).forEach((file) => {
      if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) { setNotice("References must be images no larger than 8 MB."); return; }
      const reader = new FileReader(); reader.onload = () => setAttachments((current) => [...current, String(reader.result)].slice(0, 3)); reader.readAsDataURL(file);
    });
  }

  async function createStructuredScreenplay() {
    if (!projectId) { setNotice("Create a Movie Project first so its screenplay has an isolated project_id."); return; }
    const idea = [...messages].reverse().find((message) => message.role === "user")?.text ?? detail?.project.prompt;
    if (!idea || idea.trim().length < 10) { setNotice("Describe the movie in chat before creating the screenplay."); return; }
    setStreaming(true); setNotice("Creating strict MoviePlan JSON and model-specific shot prompts…");
    try {
      const response = await fetch("/api/screenwriter/screenplay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, idea }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Unable to create screenplay.");
      const shots = payload.plan.scenes.reduce((sum: number, scene: { shots: unknown[] }) => sum + scene.shots.length, 0);
      setDetail((current) => current ? { ...current, plan: payload.plan } : current);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", time: "Now", text: `## Screenplay ready\n\nThe structured MoviePlan is saved with **${payload.plan.scenes.length} scenes** and **${shots} shots**. Character Bible, Location Bible, audio contexts, continuity state and generation prompts are ready.` }]);
      setNotice("Structured screenplay saved to Movie Project.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Screenplay generation failed."); }
    finally { setStreaming(false); }
  }

  function openGeneration() {
    if (!detail?.project || !detail.plan) return;
    const shots = detail.plan.scenes.reduce((sum, scene) => sum + scene.shots.length, 0);
    sessionStorage.setItem("cineforge.preparedProject", JSON.stringify({ projectId: detail.project.id, title: detail.project.title, durationSeconds: detail.project.durationSeconds, modelId: detail.project.modelId, resolution: detail.project.resolution, shots }));
    localStorage.setItem("cineforge.projectId", detail.project.id); router.push(`/create?project=${detail.project.id}`);
  }

  const plan = detail?.plan; const project = detail?.project;
  const shots = plan?.scenes.reduce((sum, scene) => sum + scene.shots.length, 0) ?? 0;
  const memoryLocks = [
    ...(detail?.memory?.characters ?? []).flatMap((item) => Object.entries(item.locks).filter(([, locked]) => locked).map(([key]) => `${item.name} · ${key}`)),
    ...(detail?.memory?.locations ?? []).flatMap((item) => Object.entries(item.locks).filter(([, locked]) => locked).map(([key]) => `${item.name} · ${key}`)),
  ];

  return <div className="screenwriter-grid">
    <section className="chat-workspace">
      <header className="chat-toolbar"><MessageSquareText size={16} color="var(--amber)"/><h1>AI Screenwriter</h1><select aria-label="Current Movie Project" className="chat-project-select" onChange={(event) => { setProjectId(event.target.value); void loadProject(event.target.value); }} value={projectId}><option value="">No project</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><Segmented value={mode} onChange={setMode} options={[{ value: "screenwriter", label: "Screenwriter" }, { value: "director", label: "AI Director" }]}/></header>
      <div className="message-list">
        {!messages.length ? <div className="chat-empty"><Bot size={28}/><h2>Start with a film idea</h2><p>Chat history is saved per Movie Project. Select a project for isolated long-term memory, or begin a new conversation and ask ChatGPT to prepare one.</p></div> : null}
        {messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span className="message-avatar">{message.role === "assistant" ? <Bot size={15}/> : <User size={14}/>}</span><div><div className="message-head"><strong>{message.role === "assistant" ? (mode === "director" ? "AI Director" : "ChatGPT Screenwriter") : "You"}</strong><span>{message.time}</span><div className="message-actions"><button aria-label="Copy message" onClick={() => void navigator.clipboard.writeText(message.text)} type="button"><Clipboard size={13}/></button><button aria-label="Edit message" onClick={() => setInput(message.text)} type="button"><Edit3 size={13}/></button><button aria-label="Regenerate" onClick={() => void send(message.role === "user" ? message.text : "Regenerate your previous answer with a stronger cinematic alternative.")} type="button"><RefreshCw size={13}/></button></div></div><MarkdownLite text={message.text}/>{streaming && message.id === messages.at(-1)?.id ? <span className="stream-caret"/> : null}</div></article>)}
        <div ref={bottomRef}/>
      </div>
      <div className="chat-composer-wrap">
        <div className="quick-prompts">{["Create Screenplay", "Generate Alternatives", "Make the ending tenser", "Prepare Veo prompts"].map((item) => <button key={item} onClick={() => item === "Create Screenplay" ? void createStructuredScreenplay() : void send(item)} type="button">{item}</button>)}</div>
        {attachments.length ? <div className="memory-chips" style={{ marginBottom: 7 }}>{attachments.map((_, index) => <span key={index}><ImagePlus size={11}/>Reference {index + 1}<button aria-label={`Remove reference ${index + 1}`} onClick={() => setAttachments((current) => current.filter((__, i) => i !== index))} style={{ border: 0, background: "transparent", color: "inherit" }} type="button">×</button></span>)}</div> : null}
        <div className="chat-composer"><textarea aria-label="Message AI Screenwriter" onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Develop a story, rewrite one scene, or say ‘Everything looks good. Make the movie.’" value={input}/><div className="composer-tools"><input accept="image/*" hidden multiple onChange={(event) => chooseFiles(event.target.files)} ref={fileRef} type="file"/><button aria-label="Attach reference images" onClick={() => fileRef.current?.click()} type="button"><Paperclip size={15}/></button><button aria-label="Enhance prompt with ChatGPT" disabled={!input.trim()} onClick={() => void send(`Improve this prompt while preserving its meaning. Return the improved version and explain only material changes:\n\n${input}`)} type="button"><WandSparkles size={15}/></button>{streaming ? <button aria-label="Stop generation" className="stop-button" onClick={() => abortRef.current?.abort()} type="button"><Square size={13} fill="currentColor"/> Stop</button> : <button className="send-button" disabled={!input.trim()} onClick={() => void send()} type="button"><Send size={13}/>Send</button>}</div></div>
        <p className="chat-footnote">{notice || "ChatGPT can plan and edit. Paid video jobs always require explicit budget confirmation."}</p>
      </div>
    </section>
    <aside className="screenplay-inspector">
      <div className="inspector-project"><span>CURRENT MOVIE PROJECT</span><h2>{project?.title ?? "No project selected"}</h2><p>{plan ? `${plan.summary.genre} · ${Math.round(plan.summary.durationSeconds / 60)} min · structured screenplay` : project ? `${project.status} · screenplay not created` : "Choose an existing project or create a new one"}</p><div className="context-poster resource-placeholder"><Film size={30}/><span>{project ? `${project.completedShots}/${project.totalShots} shots checkpointed` : "Project preview unavailable"}</span></div><div className="context-actions">{project ? <Button disabled={streaming} loading={streaming} onClick={() => void createStructuredScreenplay()} variant="teal"><Sparkles size={13}/>Create Screenplay</Button> : <Button onClick={() => router.push("/create")} variant="teal"><Sparkles size={13}/>Create Project</Button>}<Button disabled={!plan} onClick={openGeneration} variant="primary">Generate Movie</Button></div></div>
      <div className="outline-section"><h3>Screenplay structure</h3><div className="outline-metrics"><div><strong>{plan?.acts.length ?? 0}</strong><span>Acts</span></div><div><strong>{plan?.scenes.length ?? 0}</strong><span>Scenes</span></div><div><strong>{shots}</strong><span>Shots</span></div></div></div>
      <div className="outline-section"><h3>Acts</h3>{plan?.acts.length ? <div className="act-list">{plan.acts.map((act) => <Act key={act.id} number={String(act.number).padStart(2,"0")} title={act.title} detail={act.purpose} time={`Scenes ${act.startSceneNumber}–${act.endSceneNumber}`}/>)}</div> : <p className="field-help">No structured acts have been saved.</p>}</div>
      <div className="outline-section"><h3>Project memory in context</h3>{memoryLocks.length ? <div className="memory-chips">{memoryLocks.slice(0,12).map((item) => <span key={item}><Lock size={10}/>{item}</span>)}</div> : <p className="field-help">No locked continuity values in this project.</p>}</div>
      <div className="outline-section"><h3>Production readiness</h3><div className="stage-list"><Readiness label="Story architecture" ready={Boolean(plan)}/><Readiness label="Character Bible" ready={Boolean(plan?.characters.length)}/><Readiness label="Shot prompts" ready={Boolean(plan && plan.scenes.every((scene) => scene.shots.every((shot) => shot.generationPrompt)))}/><Readiness label="Cost confirmation" ready={false} required/></div></div>
      {notice ? <div className="secure-note" style={{ margin: 12 }}><StatusDot tone="teal"/>{notice}</div> : null}
    </aside>
  </div>;
}

function Readiness({ label, ready, required = false }: { label: string; ready: boolean; required?: boolean }) { return <div><span className={`stage-icon ${ready ? "complete" : ""}`}>{ready ? <Check size={11}/> : <Square size={9}/>}</span><strong>{label}</strong><em>{ready ? "Ready" : required ? "Required before generation" : "Not ready"}</em></div>; }
function Act({ number, title, detail, time }: { number: string; title: string; detail: string; time: string }) { return <div className="act-row"><span>{number}</span><div><strong>{title}</strong><small>{detail}</small></div><em>{time}</em></div>; }
function MarkdownLite({ text }: { text: string }) { const lines = text.split("\n"); return <div className="message-content">{lines.map((line,index) => { const rich = line.split(/(\*\*[^*]+\*\*)/g).map((piece,pieceIndex) => piece.startsWith("**") ? <strong key={pieceIndex}>{piece.slice(2,-2)}</strong> : piece); if (line.startsWith("## ")) return <h2 key={index}>{line.slice(3)}</h2>; if (line.startsWith("### ")) return <h3 key={index}>{line.slice(4)}</h3>; if (line.startsWith("- ")) return <p key={index}>• {rich.slice(1)}</p>; return line ? <p key={index}>{rich}</p> : null; })}</div>; }
