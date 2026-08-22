"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Clapperboard,
  CloudCog,
  FolderOpen,
  MapPin,
  Menu,
  MessageSquareText,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { clsx } from "clsx";

const navItems = [
  { href: "/projects", label: "Проекты", icon: FolderOpen },
  { href: "/create", label: "Создать фильм", icon: Clapperboard },
  { href: "/screenwriter", label: "ИИ-сценарист", icon: MessageSquareText },
  { href: "/characters", label: "Персонажи", icon: Users },
  { href: "/locations", label: "Локации", icon: MapPin },
  { href: "/editor", label: "Редактор", icon: Sparkles },
  { href: "/renders", label: "Рендеры", icon: CloudCog },
  { href: "/settings", label: "Настройки", icon: Settings },
] as const;

export function AppShell({
  children,
  projectTitle = "CineForge Studio",
  role = "Сценарист / ИИ-режиссёр",
  compactTop = false,
}: {
  children: ReactNode;
  projectTitle?: string;
  role?: string;
  compactTop?: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [providers, setProviders] = useState<{ google?: boolean; openai?: boolean }>({});
  useEffect(() => {
    fetch("/api/settings/status").then((response) => response.json()).then((payload) => setProviders({ google: Boolean(payload.google?.configured), openai: Boolean(payload.openai?.configured) })).catch(() => setProviders({ google: false, openai: false }));
  }, []);
  return (
    <div className={clsx("app-shell", collapsed && "nav-collapsed")}>
      <aside className="side-nav">
        <Link className="brand" href="/projects" aria-label="Проекты CineForge">
          <span className="brand-mark">C</span>
          <span>CINEFORGE</span>
        </Link>
        <nav aria-label="Основная навигация">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link className={clsx("nav-item", active && "active")} href={href} key={href}>
                <Icon aria-hidden="true" size={19} strokeWidth={1.55} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <button className="collapse-nav" onClick={() => setCollapsed((value) => !value)} type="button" aria-label={collapsed ? "Развернуть навигацию" : "Свернуть навигацию"}>
          <Menu size={17} strokeWidth={1.5} />
          <span>{collapsed ? "Развернуть" : "Свернуть"}</span>
        </button>
      </aside>

      <div className="app-column">
        <header className={clsx("top-bar", compactTop && "compact")}> 
          <Link className="project-switcher" href="/projects">
            <FolderOpen size={15} />
            <strong>{projectTitle}</strong>
          </Link>
          <div className="top-spacer" />
          <div className="autosave"><span className="status-dot green" />Проект сохраняется автоматически</div>
          <div className="provider-status"><span className={`status-dot ${providers.google === undefined ? "amber" : providers.google ? "green" : "red"}`} />Google {providers.google === undefined ? "проверка" : providers.google ? "подключён" : "не подключён"}</div>
          <div className="provider-status"><span className={`status-dot ${providers.openai === undefined ? "amber" : providers.openai ? "green" : "red"}`} />OpenAI {providers.openai === undefined ? "проверка" : providers.openai ? "подключён" : "не подключён"}</div>
          <span className="role-switcher">{role}</span>
        </header>
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}
