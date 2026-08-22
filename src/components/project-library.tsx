"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Clapperboard, KeyRound, Plus, RefreshCw } from "lucide-react";
import { formatDuration } from "@/domain/estimation";
import type { ProjectRecord } from "@/domain/movie";
import { Button, StatusDot } from "./ui";
import { errorMessageRu, projectStatusRu } from "@/lib/ru";

type LibraryFilter = "All" | "Drafts" | "Rendering" | "Completed" | "Paused" | "Failed";

export function ProjectLibrary() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [filter, setFilter] = useState<LibraryFilter>("All");
  const [offline, setOffline] = useState(false);
  const [googleConfigured, setGoogleConfigured] = useState<boolean>();
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const payload = await response.json();
      if (Array.isArray(payload.projects)) {
        setProjects(payload.infrastructure === "offline" ? [] : payload.projects);
      }
      setOffline(payload.infrastructure === "offline");
    } catch {
      setOffline(true);
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
      fetch("/api/settings/status").then((response) => response.json()).then((payload) => setGoogleConfigured(Boolean(payload.google?.configured))).catch(() => setGoogleConfigured(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const visible = useMemo(() => projects.filter((project) => {
    if (filter === "All") return true;
    if (filter === "Drafts") return project.status === "draft" || project.status === "planned";
    if (filter === "Rendering") return ["queued", "generating", "validating", "assembling"].includes(project.status);
    return project.status === filter.toLowerCase();
  }), [projects, filter]);

  return <div className="page-frame">
    <div className="page-heading">
      <div><h1>Библиотека проектов</h1><p>Все фильмы, контрольные точки и активные рендеры в едином восстанавливаемом пространстве.</p></div>
      <div className="page-actions"><Button loading={loading} onClick={load}><RefreshCw size={14} />Обновить</Button><Link className="button button-primary" href="/create"><Plus size={14} />Новый проект</Link></div>
    </div>
    {googleConfigured === false ? <div className="secure-note" style={{ margin: "4px 0 14px" }}><KeyRound size={15} />Подключите ключ Google Gemini перед генерацией видео.<Link className="button button-teal" style={{ marginLeft: "auto" }} href="/settings">Открыть «Настройки → API»</Link></div> : null}
    <div className="filter-tabs">
      {(["All","Drafts","Rendering","Completed","Paused","Failed"] as LibraryFilter[]).map((item) => <button className={filter === item ? "active" : ""} key={item} onClick={() => setFilter(item)} type="button">{{ All: "Все", Drafts: "Черновики", Rendering: "В работе", Completed: "Готовые", Paused: "Приостановленные", Failed: "С ошибкой" }[item]}</button>)}
      {offline ? <span style={{ marginLeft: "auto", paddingBottom: 11, color: "var(--muted)", fontSize: 9 }}>Облачная инфраструктура недоступна</span> : null}
    </div>
    <div className="project-grid">
      <Link className="new-project-card" href="/create"><div><span><Plus size={18} /></span><strong>Создать новый фильм</strong></div></Link>
      {visible.map((project) => <article className="project-card" key={project.id}>
        <Link className="project-poster project-placeholder" href={`${project.status === "completed" ? "/editor" : "/create"}?project=${project.id}`} onClick={() => localStorage.setItem("cineforge.projectId", project.id)}>
          <Clapperboard size={30}/><span className="placeholder-label">{project.completedShots ? `Сохранено кадров: ${project.completedShots}` : "Постер появится после генерации"}</span>
          <span className="project-status"><StatusDot tone={project.status === "completed" ? "green" : project.status === "paused" ? "amber" : project.status === "failed" ? "red" : "teal"} />{projectStatusRu(project.status)}</span>
          <span className="project-duration">{formatDuration(project.durationSeconds)}</span>
        </Link>
        <div className="project-card-body"><h2>{project.title}</h2><p>{project.modelId} · {project.resolution}</p>{project.lastError?.message ? <p style={{ color: "var(--red)" }}>{errorMessageRu(project.lastError.message, "Проект остановлен с ошибкой.")}</p> : null}<div className="project-progress"><i style={{ width: `${project.progress}%` }} /></div><div className="project-meta"><span>{project.completedShots}/{project.totalShots} кадров</span><span>${Number(project.spentUsd).toFixed(2)}</span><span>{project.progress}%</span></div></div>
      </article>)}
    </div>
    {!visible.length ? <div className="empty-state"><div><Clapperboard size={27} /><h2>Здесь пока нет проектов</h2><p>Создайте новый фильм или выберите другой фильтр.</p><Link className="button button-primary" href="/create">Создать фильм</Link></div></div> : null}
  </div>;
}
