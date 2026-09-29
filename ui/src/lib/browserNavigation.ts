import { paperclipPath } from "./base-path";

export function navigateTopLevel(target: string) {
  window.location.assign(target.startsWith("/") && !target.startsWith("//") ? paperclipPath(target) : target);
}
