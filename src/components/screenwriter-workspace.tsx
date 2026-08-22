"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Bot, Check, Clipboard, Edit3, ImagePlus, Lock, MessageSquareText, Paperclip,
  RefreshCw, Send, Sparkles, Square, User, WandSparkles,
} from "lucide-react";
import { Button, Segmented } from "./ui";

type Message = { id: string; role: "user" | "assistant"; text: string; time: string };

const initialMessages: Message[] = [{
  id: "welcome", role: "assistant", time: "Now",
  text: "## Glass Horizon\n\nI’ve shaped your idea into a grounded **20-minute neo-noir detective film**. Elias Ward, an investigative journalist with a reputation for crossing lines, follows a missing-person case into a real-estate conspiracy that is quietly erasing entire blocks of winter Manhattan.\n\n**Logline:** A burned-out journalist uncovers a corporate cover-up behind a disappearance, forcing him to choose between publishing the truth and protecting the only witness.\n\n### Act I — The Vanishing\nA corrupted voice message pulls Elias back into the story that ended his career. The silver evidence drive appears in Apartment 4B.\n\n### Act II — The Glass City\nElias follows the signal through interrogations, winter streets and Vale’s empty developments. Mara reveals the missing man was deliberately erased from public records.\n\n### Act III — The Choice\nThe rooftop transmission exposes Vale’s operation, but publishing it will reveal Mara’s identity. Elias makes the moral choice that ends the case without neatly resolving his guilt.\n\nThe current outline has **3 acts, 24 scenes and approximately 124 shots**. Character identity, wardrobe, apartment layout and the silver evidence drive are locked in Project Memory.",
}];

export function ScreenwriterWorkspace() {
  const router = useRouter();
  const [mode, setMode] = useState<"screenwriter" | "director">("screenwriter");
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const [previousResponseId, setPreviousResponseId] = useState<string>();
  const [attachments, setAttachments] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const projectId = localStorage.getItem("cineforge.projectId");
      if (!projectId) return;
      try {
        const response = await fetch(`/api/screenwriter/history?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        const payload = await response.json();
        if (Array.isArray(payload.messages) && payload.messages.length) {
          setMessages(payload.messages.map((message: { id: string; role: string; content?: { text?: string }; created_at?: string }) => ({
            id: message.id,
            role: message.role === "user" ? "user" : "assistant",
            text: message.content?.text ?? "",
            time: message.created_at ? new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Saved",
          })));
          setConversationId(payload.conversations?.[0]?.id);
          setPreviousResponseId(payload.conversations?.[0]?.last_response_id ?? undefined);
        }
      } catch { /* The local draft remains available while infrastructure starts. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || streaming) return;
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", text, time: "Now" };
    const assistantId = crypto.randomUUID();
    setMessages((current) => [...current, userMessage, { id: assistantId, role: "assistant", text: "", time: "Now" }]);
    setInput("");
    setStreaming(true);
    setNotice("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const projectId = localStorage.getItem("cineforge.projectId") ?? undefined;
      const response = await fetch("/api/screenwriter/chat", {
        method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, projectId, conversationId, previousResponseId, mode, attachments }),
      });
      if (!response.ok || !response.body) throw new Error((await response.json()).error ?? "AI Screenwriter is unavailable.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = frame.match(/^event: (.+)$/m)?.[1];
          const raw = frame.match(/^data: (.+)$/m)?.[1];
          if (!raw) continue;
          const payload = JSON.parse(raw);
          if (event === "meta") setConversationId(payload.conversationId);
          if (event === "delta") setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, text: item.text + payload.delta } : item));
          if (event === "done") setPreviousResponseId(payload.responseId);
          if (event === "action" && payload.prepared?.projectId) {
            localStorage.setItem("cineforge.projectId", payload.prepared.projectId);
            sessionStorage.setItem("cineforge.preparedProject", JSON.stringify(payload.prepared));
            setNotice(`Movie Project “${payload.prepared.title}” prepared with ${payload.prepared.shots} shots. Open Generate Movie to review cost and budget.`);
          }
          if (event === "error") throw new Error(payload.error);
        }
      }
      setAttachments([]);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, text: `I couldn’t complete that request: ${(error as Error).message}` } : item));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function chooseFiles(files: FileList | null) {
    if (!files) return;
    [...files].slice(0, 3).forEach((file) => {
      if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) return;
      const reader = new FileReader();
      reader.onload = () => setAttachments((current) => [...current, String(reader.result)].slice(0, 3));
      reader.readAsDataURL(file);
    });
  }

  async function createStructuredScreenplay() {
    const projectId = localStorage.getItem("cineforge.projectId");
    if (!projectId) { setNotice("Create a Movie Project first so the structured screenplay has an isolated project_id."); router.push("/create"); return; }
    setStreaming(true); setNotice("Creating strict MoviePlan JSON and model-specific shot prompts…");
    try {
      const idea = [...messages].reverse().find((message) => message.role === "user")?.text ?? "Create the complete Glass Horizon screenplay from the approved concept.";
      const response = await fetch("/api/screenwriter/screenplay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, idea, durationSeconds: 1_200 }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to create screenplay.");
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", time: "Now", text: `## Screenplay ready\n\nThe structured MoviePlan was saved to this project with **${payload.plan.scenes.length} scenes** and **${payload.plan.scenes.reduce((sum: number, scene: { shots: unknown[] }) => sum + scene.shots.length, 0)} shots**. Character Bible, Location Bible, audio contexts, continuity state and model-specific generation prompts are ready for cost confirmation.` }]);
      setNotice("Structured screenplay saved to Movie Project.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Screenplay generation failed."); }
    finally { setStreaming(false); }
  }

  return <div className="screenwriter-grid">
    <section className="chat-workspace">
      <header className="chat-toolbar"><MessageSquareText size={16} color="var(--amber)" /><h1>AI Screenwriter</h1><span>Project-aware conversation</span><Segmented value={mode} onChange={setMode} options={[{ value: "screenwriter", label: "Screenwriter" }, { value: "director", label: "AI Director" }]} /></header>
      <div className="message-list">
        {messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
          <span className="message-avatar">{message.role === "assistant" ? <Bot size={15} /> : <User size={14} />}</span>
          <div><div className="message-head"><strong>{message.role === "assistant" ? (mode === "director" ? "AI Director" : "ChatGPT Screenwriter") : "You"}</strong><span>{message.time}</span><div className="message-actions"><button aria-label="Copy message" onClick={() => navigator.clipboard.writeText(message.text)} type="button"><Clipboard size={13} /></button><button aria-label="Edit message" onClick={() => setInput(message.text)} type="button"><Edit3 size={13} /></button><button aria-label="Regenerate" onClick={() => void send(message.role === "user" ? message.text : "Regenerate your previous answer with a stronger cinematic alternative.")} type="button"><RefreshCw size={13} /></button></div></div><MarkdownLite text={message.text} />{streaming && message.id === messages.at(-1)?.id ? <span className="stream-caret" /> : null}</div>
        </article>)}
        <div ref={bottomRef} />
      </div>
      <div className="chat-composer-wrap">
        <div className="quick-prompts">{["Create Screenplay", "Generate Alternatives", "Make the ending tenser", "Prepare Veo prompts"].map((item) => <button key={item} onClick={() => item === "Create Screenplay" ? void createStructuredScreenplay() : void send(item)} type="button">{item}</button>)}</div>
        {attachments.length ? <div className="memory-chips" style={{ marginBottom: 7 }}>{attachments.map((_, index) => <span key={index}><ImagePlus size={11} />Reference {index + 1}<button onClick={() => setAttachments((current) => current.filter((__, i) => i !== index))} style={{ border: 0, background: "transparent", color: "inherit" }} type="button">×</button></span>)}</div> : null}
        <div className="chat-composer"><textarea aria-label="Message AI Screenwriter" onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Develop the story, rewrite one scene, or say ‘Everything looks good. Make the movie.’" value={input} /><div className="composer-tools"><input accept="image/*" hidden multiple onChange={(event) => chooseFiles(event.target.files)} ref={fileRef} type="file" /><button aria-label="Attach reference images" onClick={() => fileRef.current?.click()} type="button"><Paperclip size={15} /></button><button aria-label="Enhance prompt" onClick={() => setInput((current) => current ? `Improve this while preserving its meaning: ${current}` : current)} type="button"><WandSparkles size={15} /></button>{streaming ? <button aria-label="Stop generation" className="stop-button" onClick={() => abortRef.current?.abort()} type="button"><Square size={13} fill="currentColor" /> Stop</button> : <button className="send-button" onClick={() => send()} type="button"><Send size={13} />Send</button>}</div></div>
        <p className="chat-footnote">{notice || "ChatGPT can plan and edit. Paid video jobs always require your explicit budget confirmation."}</p>
      </div>
    </section>
    <aside className="screenplay-inspector">
      <div className="inspector-project"><span>CURRENT MOVIE PROJECT</span><h2>Glass Horizon</h2><p>Neo-noir detective drama · 20 min · draft screenplay</p><div className="context-poster"><Image alt="Glass Horizon" fill loading="eager" sizes="550px" src="/assets/glass-horizon-street.png" /></div><div className="context-actions"><Button loading={streaming} onClick={() => void createStructuredScreenplay()} variant="teal"><Sparkles size={13} />Create Screenplay</Button><Button onClick={() => router.push("/create")} variant="primary">Generate Movie</Button></div></div>
      <div className="outline-section"><h3>Screenplay structure</h3><div className="outline-metrics"><div><strong>3</strong><span>Acts</span></div><div><strong>24</strong><span>Scenes</span></div><div><strong>124</strong><span>Shots</span></div></div></div>
      <div className="outline-section"><h3>Acts</h3><div className="act-list"><Act number="01" title="The Vanishing" detail="Set-up · inciting evidence" time="00–05m" /><Act number="02" title="The Glass City" detail="Investigation · betrayal" time="05–16m" /><Act number="03" title="The Choice" detail="Rooftop climax · resolution" time="16–20m" /></div></div>
      <div className="outline-section"><h3>Project memory in context</h3><div className="memory-chips"><span><Lock size={10} />Elias face</span><span><Lock size={10} />Charcoal coat</span><span><Lock size={10} />Mara voice</span><span><Lock size={10} />Apartment 4B</span><span><Lock size={10} />Silver drive</span></div></div>
      <div className="outline-section"><h3>Production readiness</h3><div className="stage-list"><div><span className="stage-icon complete"><Check size={11} /></span><strong>Story architecture</strong><em>Ready</em></div><div><span className="stage-icon complete"><Check size={11} /></span><strong>Character bible</strong><em>Ready</em></div><div><span className="stage-icon active"><span /></span><strong>Shot prompts</strong><em>92%</em></div><div><span className="stage-icon"><Square size={9} /></span><strong>Cost confirmation</strong><em>Required</em></div></div></div>
    </aside>
  </div>;
}

function Act({ number, title, detail, time }: { number: string; title: string; detail: string; time: string }) { return <div className="act-row"><span>{number}</span><div><strong>{title}</strong><small>{detail}</small></div><em>{time}</em></div>; }

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  return <div className="message-content">{lines.map((line, index) => {
    const rich = line.split(/(\*\*[^*]+\*\*)/g).map((piece, pieceIndex) => piece.startsWith("**") ? <strong key={pieceIndex}>{piece.slice(2,-2)}</strong> : piece);
    if (line.startsWith("## ")) return <h2 key={index}>{line.slice(3)}</h2>;
    if (line.startsWith("### ")) return <h3 key={index}>{line.slice(4)}</h3>;
    if (line.startsWith("- ")) return <p key={index}>• {rich.slice(1)}</p>;
    return line ? <p key={index}>{rich}</p> : null;
  })}</div>;
}
