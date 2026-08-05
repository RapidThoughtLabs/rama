import type { ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "icon";
  size?: "md" | "sm";
}

export function Button({ variant = "primary", size = "md", className, ...rest }: ButtonProps) {
  const classes = [
    "rama-btn",
    variant === "primary" && "rama-btn-primary",
    variant === "ghost" && "rama-btn-ghost",
    variant === "icon" && "rama-btn-icon",
    size === "sm" && "rama-btn-sm",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button className={classes} {...rest} />;
}
