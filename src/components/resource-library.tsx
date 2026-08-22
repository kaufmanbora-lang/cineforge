"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Film, Lock, MapPin, Search, Unlock, Users, Volume2 } from "lucide-react";
import type { Character, Location, MoviePlan, ProjectRecord } from "@/domain/movie";
import { Button, StatusDot } from "./ui";
import { errorMessageRu, lockLabelRu } from "@/lib/ru";

type Filter = "all" | "locked" | "needs-reference";
type MemoryRow<T> = { id: string; name: string; bible: T; current_state: Record<string, unknown>; locks: Record<string, boolean> };
type DetailPayload = {
  project: ProjectRecord;
  plan: MoviePlan | null;
  memory: { characters: MemoryRow<Character>[]; locations: MemoryRow<Location>[] };
  infrastructure?: string;
  error?: string;
};

export function ResourceLibrary({ kind }: { kind: "characters" | "locations" }) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState("");
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>();

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    setNotice("Загрузка памяти проекта…");
    try {
      const response = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json() as DetailPayload;
      if (!response.ok || payload.infrastructure === "offline") throw new Error(errorMessageRu(payload.error, "Облачная инфраструктура проекта недоступна."));
      setDetail(payload);
      setNotice("");
    } catch (error) {
      setDetail(null);
      setNotice(errorMessageRu(error, "Не удалось загрузить память проекта."));
    }
  }, []);

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
        if (selected) {
          localStorage.setItem("cineforge.projectId", selected);
          await loadDetail(selected);
        }
      } catch { setNotice("Облачная инфраструктура проекта недоступна."); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDetail]);

  const items = useMemo(() => {
    const rows = kind === "characters" ? detail?.memory.characters ?? [] : detail?.memory.locations ?? [];
    return rows.filter((item) => {
      const matchesSearch = !search || `${item.name} ${JSON.stringify(item.bible)}`.toLowerCase().includes(search.toLowerCase());
      const locked = Object.values(item.locks ?? {}).some(Boolean);
      const references = item.bible.referenceAssetIds ?? [];
      return matchesSearch && (filter === "all" || (filter === "locked" && locked) || (filter === "needs-reference" && references.length === 0));
    });
  }, [detail, filter, kind, search]);

  async function updateLocks(item: MemoryRow<Character> | MemoryRow<Location>, key: string) {
    if (!projectId) return;
    const nextLocks = { ...item.locks, [key]: !item.locks[key] };
    setBusy(`${item.id}:${key}`);
    try {
      const response = await fetch("/api/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, resourceKind: kind === "characters" ? "character" : "location", resourceId: item.id, locks: nextLocks }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(errorMessageRu(payload.error, "Не удалось изменить блокировку."));
      await loadDetail(projectId);
      setNotice(`${item.name}: блокировки согласованности сохранены.`);
    } catch (error) { setNotice(errorMessageRu(error, "Не удалось изменить блокировку.")); }
    finally { setBusy(undefined); }
  }

  const title = kind === "characters" ? "Персонажи" : "Локации";
  const Icon = kind === "characters" ? Users : MapPin;
  return <div className="page-frame">
    <div className="page-heading"><div><h1>{title}</h1><p>{kind === "characters" ? "Библия персонажей, одежда, постоянные голоса и блокировки внешности активного проекта." : "Библия локаций, расположение объектов, освещение, погода и блокировки дизайна активного проекта."}</p></div><div className="page-actions"><select aria-label="Текущий кинопроект" className="settings-select project-select" onChange={(event) => { const id = event.target.value; setProjectId(id); localStorage.setItem("cineforge.projectId", id); void loadDetail(id); }} value={projectId}><option value="">Выберите проект</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></div></div>
    <div className="resource-toolbar"><label className="resource-search"><Search size={14}/><input aria-label={`Поиск: ${title}`} onChange={(event) => setSearch(event.target.value)} placeholder={`Поиск: ${title.toLowerCase()}…`} value={search}/></label>{notice ? <span><StatusDot tone={detail ? "teal" : "red"}/>{notice}</span> : null}</div>
    <div className="filter-tabs">{([{ value: "all", label: "Все" }, { value: "locked", label: "Заблокированные" }, { value: "needs-reference", label: "Нужен референс" }] as const).map((item) => <button className={filter === item.value ? "active" : ""} key={item.value} onClick={() => setFilter(item.value)} type="button">{item.label}</button>)}</div>
    <div className="resource-grid">{items.map((item) => {
      const character = kind === "characters" ? item.bible as Character : null;
      const location = kind === "locations" ? item.bible as Location : null;
      const keys = kind === "characters" ? ["appearance", "voice", "outfit"] : ["design"];
      const detailText = character ? `${character.age} · ${character.personality}` : location ? `${location.architecture} · ${location.timeOfDay}` : "";
      const stateText = Object.keys(item.current_state ?? {}).length ? Object.values(item.current_state).filter((value) => typeof value === "string").join(" · ") : "Состояние ещё не создано";
      return <article className="resource-card" key={item.id}><div className="resource-image resource-placeholder"><Icon size={30}/><span>Референсов: {item.bible.referenceAssetIds?.length ?? 0}</span></div><div className="resource-card-body"><h2>{item.name}</h2><p>{detailText}</p><div className="memory-facts" style={{ marginBottom: 8 }}><p>{character ? <Volume2 size={12}/> : <MapPin size={12}/>} {stateText}</p></div><div className="lock-list lock-actions">{keys.map((key) => { const locked = Boolean(item.locks?.[key]); return <Button disabled={busy === `${item.id}:${key}`} key={key} onClick={() => void updateLocks(item, key)} variant={locked ? "teal" : "ghost"}>{locked ? <Lock size={10}/> : <Unlock size={10}/>} {lockLabelRu(key)}</Button>; })}</div></div></article>;
    })}</div>
    {!projectId ? <div className="empty-state"><div><Film size={27}/><h2>Нет активного кинопроекта</h2><p>Создайте проект и сценарий, прежде чем управлять памятью согласованности.</p><a className="button button-primary" href="/create">Создать фильм</a></div></div> : projectId && !items.length ? <div className="empty-state"><div><Icon size={27}/><h2>Ничего не найдено</h2><p>{detail?.plan ? "Измените поиск или фильтр." : "Создайте структурированный сценарий, чтобы наполнить память проекта."}</p></div></div> : null}
  </div>;
}
