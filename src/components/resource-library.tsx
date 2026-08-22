"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Film, Lock, MapPin, Search, Unlock, Users, Volume2 } from "lucide-react";
import type { Character, Location, MoviePlan, ProjectRecord } from "@/domain/movie";
import { Button, StatusDot } from "./ui";

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
    setNotice("Loading Project Memory…");
    try {
      const response = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json() as DetailPayload;
      if (!response.ok || payload.infrastructure === "offline") throw new Error(payload.error ?? "Project infrastructure is offline.");
      setDetail(payload);
      setNotice("");
    } catch (error) {
      setDetail(null);
      setNotice(error instanceof Error ? error.message : "Unable to load Project Memory.");
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
      } catch { setNotice("Project infrastructure is offline."); }
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
      if (!response.ok) throw new Error(payload.error ?? "Unable to update the lock.");
      await loadDetail(projectId);
      setNotice(`${item.name}: continuity locks saved.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to update the lock."); }
    finally { setBusy(undefined); }
  }

  const title = kind === "characters" ? "Characters" : "Locations";
  const Icon = kind === "characters" ? Users : MapPin;
  return <div className="page-frame">
    <div className="page-heading"><div><h1>{title}</h1><p>{kind === "characters" ? "Character Bible, wardrobe, voice identity and appearance locks from the active project." : "Location Bible, object layout, lighting, weather and design locks from the active project."}</p></div><div className="page-actions"><select aria-label="Current Movie Project" className="settings-select project-select" onChange={(event) => { const id = event.target.value; setProjectId(id); localStorage.setItem("cineforge.projectId", id); void loadDetail(id); }} value={projectId}><option value="">Select a project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></div></div>
    <div className="resource-toolbar"><label className="resource-search"><Search size={14}/><input aria-label={`Search ${title}`} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${title.toLowerCase()}…`} value={search}/></label>{notice ? <span><StatusDot tone={detail ? "teal" : "red"}/>{notice}</span> : null}</div>
    <div className="filter-tabs">{([{ value: "all", label: "All" }, { value: "locked", label: "Locked" }, { value: "needs-reference", label: "Needs reference" }] as const).map((item) => <button className={filter === item.value ? "active" : ""} key={item.value} onClick={() => setFilter(item.value)} type="button">{item.label}</button>)}</div>
    <div className="resource-grid">{items.map((item) => {
      const character = kind === "characters" ? item.bible as Character : null;
      const location = kind === "locations" ? item.bible as Location : null;
      const keys = kind === "characters" ? ["appearance", "voice", "outfit"] : ["design"];
      const detailText = character ? `${character.age} · ${character.personality}` : location ? `${location.architecture} · ${location.timeOfDay}` : "";
      const stateText = Object.keys(item.current_state ?? {}).length ? Object.values(item.current_state).filter((value) => typeof value === "string").join(" · ") : "No generated scene state yet";
      return <article className="resource-card" key={item.id}><div className="resource-image resource-placeholder"><Icon size={30}/><span>{item.bible.referenceAssetIds?.length ?? 0} reference assets</span></div><div className="resource-card-body"><h2>{item.name}</h2><p>{detailText}</p><div className="memory-facts" style={{ marginBottom: 8 }}><p>{character ? <Volume2 size={12}/> : <MapPin size={12}/>} {stateText}</p></div><div className="lock-list lock-actions">{keys.map((key) => { const locked = Boolean(item.locks?.[key]); return <Button disabled={busy === `${item.id}:${key}`} key={key} onClick={() => void updateLocks(item, key)} variant={locked ? "teal" : "ghost"}>{locked ? <Lock size={10}/> : <Unlock size={10}/>} {key}</Button>; })}</div></div></article>;
    })}</div>
    {!projectId ? <div className="empty-state"><div><Film size={27}/><h2>No active Movie Project</h2><p>Create a project and its screenplay before managing continuity memory.</p><a className="button button-primary" href="/create">Create Movie</a></div></div> : projectId && !items.length ? <div className="empty-state"><div><Icon size={27}/><h2>No matching {title.toLowerCase()}</h2><p>{detail?.plan ? "Change the search or filter." : "Create a structured screenplay to populate Project Memory."}</p></div></div> : null}
  </div>;
}
