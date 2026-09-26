import { cn } from "../lib/utils";
import { paperclipPath } from "@/lib/base-path";

interface OpenCodeLogoIconProps {
  className?: string;
}

export function OpenCodeLogoIcon({ className }: OpenCodeLogoIconProps) {
  return (
    <>
      <img
        src={paperclipPath("/brands/opencode-logo-light-square.svg")}
        alt="OpenCode"
        className={cn("dark:hidden", className)}
      />
      <img
        src={paperclipPath("/brands/opencode-logo-dark-square.svg")}
        alt="OpenCode"
        className={cn("hidden dark:block", className)}
      />
    </>
  );
}
