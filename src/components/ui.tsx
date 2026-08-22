"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";
import { LoaderCircle } from "lucide-react";

export function Button({
  children,
  variant = "default",
  loading = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "teal" | "danger" | "ghost";
  loading?: boolean;
}) {
  return (
    <button className={clsx("button", `button-${variant}`, className)} {...props}>
      {loading ? <LoaderCircle className="spin" size={15} /> : null}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button className={value === option.value ? "selected" : ""} key={option.value} onClick={() => onChange(option.value)} type="button">
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PanelHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="panel-heading"><span>{children}</span>{action}</div>;
}

export function StatusDot({ tone = "green" }: { tone?: "green" | "amber" | "red" | "teal" }) {
  return <span className={clsx("status-dot", tone)} />;
}
