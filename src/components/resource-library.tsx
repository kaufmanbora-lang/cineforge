"use client";

import Image from "next/image";
import { Lock, MapPin, Plus, Search, Users, Volume2 } from "lucide-react";
import { Button } from "./ui";

const characters = [
  { name: "Elias Ward", detail: "32 · investigative journalist", image: "/assets/glass-horizon-street.png", state: "Scene 13 · rooftop", locks: ["Face", "Voice", "Charcoal coat"] },
  { name: "Mara Voss", detail: "38 · reluctant witness", image: "/assets/glass-horizon-interrogation.png", state: "Scene 12 · precinct", locks: ["Appearance", "Voice"] },
  { name: "Adrian Vale", detail: "54 · property magnate", image: "/assets/glass-horizon-rooftop.png", state: "Scene 14 · tower", locks: ["Face", "Navy suit"] },
];
const locations = [
  { name: "Apartment 4B", detail: "Pre-war Manhattan apartment", image: "/assets/glass-horizon-interrogation.png", state: "Night · tungsten practicals", locks: ["Layout", "Window view"] },
  { name: "West 46th Street", detail: "Winter commercial block", image: "/assets/glass-horizon-street.png", state: "Night · light snow", locks: ["Architecture", "Weather"] },
  { name: "Vale Tower Roof", detail: "Glass-and-steel rooftop", image: "/assets/glass-horizon-rooftop.png", state: "Blue hour · high wind", locks: ["Skyline", "Antenna"] },
];

export function ResourceLibrary({ kind }: { kind: "characters" | "locations" }) {
  const items = kind === "characters" ? characters : locations;
  const title = kind === "characters" ? "Characters" : "Locations";
  const Icon = kind === "characters" ? Users : MapPin;
  return <div className="page-frame">
    <div className="page-heading"><div><h1>{title}</h1><p>{kind === "characters" ? "Character Bible, wardrobe states, voice identity and locked appearance." : "Location Bible, object layout, lighting, weather and reference frames."}</p></div><div className="page-actions"><Button><Search size={14} />Search</Button><Button variant="primary"><Plus size={14} />Add {kind === "characters" ? "character" : "location"}</Button></div></div>
    <div className="filter-tabs"><button className="active" type="button">All</button><button type="button">Locked</button><button type="button">Needs reference</button><button type="button">Used in current scene</button></div>
    <div className="resource-grid">{items.map((item) => <article className="resource-card" key={item.name}><div className="resource-image"><Image alt={item.name} fill sizes="33vw" src={item.image} /></div><div className="resource-card-body"><h2>{item.name}</h2><p>{item.detail}</p><div className="memory-facts" style={{ marginBottom: 8 }}><p>{kind === "characters" ? <Volume2 size={12} /> : <Icon size={12} />}{item.state}</p></div><div className="lock-list">{item.locks.map((lock) => <span key={lock}><Lock size={9} />{lock}</span>)}</div></div></article>)}</div>
  </div>;
}
