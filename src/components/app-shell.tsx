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
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/create", label: "Create Movie", icon: Clapperboard },
  { href: "/screenwriter", label: "AI Screenwriter", icon: MessageSquareText },
  { href: "/characters", label: "Characters", icon: Users },
  { href: "/locations", label: "Locations", icon: MapPin },
  { href: "/editor", label: "Editor", icon: Sparkles },
  { href: "/renders", label: "Renders", icon: CloudCog },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({
  children,
  projectTitle = "CineForge Studio",
  role = "Screenwriter / AI Director",
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
        <Link className="brand" href="/projects" aria-label="CineForge projects">
          <span className="brand-mark">C</span>
          <span>CINEFORGE</span>
        </Link>
        <nav aria-label="Primary navigation">
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
        <button className="collapse-nav" onClick={() => setCollapsed((value) => !value)} type="button" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
          <Menu size={17} strokeWidth={1.5} />
          <span>{collapsed ? "Expand" : "Collapse"}</span>
        </button>
      </aside>

      <div className="app-column">
        <header className={clsx("top-bar", compactTop && "compact")}> 
          <Link className="project-switcher" href="/projects">
            <FolderOpen size={15} />
            <strong>{projectTitle}</strong>
          </Link>
          <div className="top-spacer" />
          <div className="autosave"><span className="status-dot green" />Persistent project state</div>
          <div className="provider-status"><span className={`status-dot ${providers.google === undefined ? "amber" : providers.google ? "green" : "red"}`} />Google {providers.google === undefined ? "checking" : providers.google ? "configured" : "not configured"}</div>
          <div className="provider-status"><span className={`status-dot ${providers.openai === undefined ? "amber" : providers.openai ? "green" : "red"}`} />OpenAI {providers.openai === undefined ? "checking" : providers.openai ? "configured" : "not configured"}</div>
          <span className="role-switcher">{role}</span>
        </header>
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}
