"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Film, Play, RefreshCw, RotateCcw } from "lucide-react";
import type { ProjectRecord } from "@/domain/movie";
import { Button, StatusDot } from "./ui";

type RenderFilter = "Active" | "Completed" | "Paused" | "Failed";

const activeStatuses = new Set(["planned", "queued", "generating", "validating", "retrying", "assembling"]);
export function RendersWorkspace() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [filter, setFilter] = useState<RenderFilter>("Active");
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.infrastructure === "offline") throw new Error(payload.error ?? "Movie infrastructure is offline.");
      setProjects(Array.isArray(payload.projects) ? payload.projects : []);
      setOffline(false);
    } catch (error) {
      setProjects([]);
      setOffline(true);
      setNotice(error instanceof Error ? error.message : "Unable to load render jobs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const visible = useMemo(() => projects.filter((project) => {
    if (filter === "Active") return activeStatuses.has(project.status);
    return project.status === filter.toLowerCase();
  }), [filter, projects]);

  async function resume(projectId: string) {
    setResuming(projectId);
    setNotice("Restoring the latest checkpoint…");
    try {
      const response = await fetch(`/api/projects/${projectId}/resume`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Resume failed.");
      setNotice(`${payload.queued ?? 0} unfinished jobs restored without regenerating completed shots.`);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Resume failed.");
    } finally {
      setResuming(null);
    }
  }

  async function resumeAll() {
    const recoverable = projects.filter((project) => project.status === "paused" || project.status === "failed");
    if (!recoverable.length) { setNotice("No paused or failed project is currently recoverable."); return; }
    for (const project of recoverable) await resume(project.id);
  }

  return <div className="page-frame">
    <div className="page-heading"><div><h1>Renders</h1><p>Live background jobs, checkpoints, completed masters and recoverable failures.</p></div><div className="page-actions"><Button loading={loading} onClick={load}><RefreshCw size={14}/>Refresh</Button><Button disabled={offline || loading} onClick={() => void resumeAll()}><RotateCcw size={14}/>Resume all available</Button></div></div>
    <div className="filter-tabs">{(["Active", "Completed", "Paused", "Failed"] as RenderFilter[]).map((item) => <button className={filter === item ? "active" : ""} key={item} onClick={() => setFilter(item)} type="button">{item}</button>)}</div>
    {notice ? <div className="secure-note" style={{ marginBottom: 12 }}><StatusDot tone={offline ? "red" : "teal"}/>{notice}</div> : null}
    <div className="settings-content">
      {visible.map((project) => {
        const complete = project.status === "completed";
        const recoverable = project.status === "paused" || project.status === "failed";
        return <section className="settings-card" key={project.id}>
          <header className="settings-card-head"><span className="provider-mark"><StatusDot tone={complete ? "green" : recoverable ? "amber" : "teal"}/></span><div><h2>{project.title} · {project.renderTier === "draft" ? "Fast Draft" : "Final Quality"}</h2><p>{project.completedShots} of {project.totalShots} shots checkpointed · {project.modelId}</p></div><span className="connection" style={{ color: complete ? "var(--green)" : recoverable ? "var(--amber)" : "var(--teal)" }}>{project.status} · {project.progress}%</span></header>
          <div className="settings-card-body" style={{ display: "grid", gridTemplateColumns: "180px minmax(0,1fr) auto", gap: 14, alignItems: "center" }}>
            <div className="resource-image resource-placeholder" style={{ aspectRatio: "16/9", borderRadius: 4, overflow: "hidden" }}><Film size={24}/><span>{project.completedShots ? `${project.completedShots} shots ready` : "Awaiting first shot"}</span></div>
            <div><div className="project-progress"><i style={{ width: `${project.progress}%` }}/></div><p className="field-help">{project.completedShots} completed · {Math.max(0, project.totalShots - project.completedShots)} unfinished · checkpoints are persistent</p><div className="memory-chips"><span>{project.resolution}</span><span>{project.aspectRatio}</span><span>${Number(project.spentUsd).toFixed(2)} / ${Number(project.maximumBudgetUsd).toFixed(2)}</span></div></div>
            <div className="page-actions" style={{ justifyContent: "flex-end" }}>
              {complete ? <><Link className="button button-teal" href={`/editor?project=${project.id}`} onClick={() => localStorage.setItem("cineforge.projectId", project.id)}><Play size={13}/>Edit</Link><a className="button button-primary" href={`/api/projects/${project.id}/downloads/mp4`}><Download size={13}/>MP4</a><a className="button" href={`/api/projects/${project.id}/downloads/srt`}>SRT</a><a className="button" href={`/api/projects/${project.id}/downloads/archive`}>Archive</a></> : null}
              {recoverable ? <Button loading={resuming === project.id} onClick={() => void resume(project.id)} variant="primary"><RotateCcw size={13}/>Resume</Button> : null}
              {activeStatuses.has(project.status) ? <Link className="button button-teal" href={`/editor?project=${project.id}`} onClick={() => localStorage.setItem("cineforge.projectId", project.id)}><Play size={13}/>Open preview</Link> : null}
            </div>
          </div>
        </section>;
      })}
    </div>
    {!loading && !visible.length ? <div className="empty-state"><div><Film size={27}/><h2>{offline ? "Movie infrastructure is offline" : `No ${filter.toLowerCase()} renders`}</h2><p>{offline ? "Start PostgreSQL and Redis, then refresh. No preview job data is substituted." : "Projects will appear here as their persisted status changes."}</p>{offline ? <Button onClick={load}>Retry connection</Button> : <Link className="button button-primary" href="/create">Create Movie</Link>}</div></div> : null}
  </div>;
}
