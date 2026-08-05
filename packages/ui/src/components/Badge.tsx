import type { HTMLAttributes } from "react";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "accent" | "good" | "warn" | "dim";
  dot?: boolean;
}

export function Badge({ tone = "dim", dot = false, className, ...rest }: BadgeProps) {
  const classes = ["rama-badge", `rama-badge-${tone}`, dot && "rama-badge-dot", className].filter(Boolean).join(" ");
  return <span className={classes} {...rest} />;
}
