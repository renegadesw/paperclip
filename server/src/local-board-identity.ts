/** A synthetic board identity must not collide across shared-DB installations. */
export function localBoardUserId(env: NodeJS.ProcessEnv = process.env): string {
  const installationId = env.PAPERCLIP_VECTOR_INSTALLATION_ID?.trim();
  if (!installationId) return "local-board";
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(installationId)) {
    throw new Error("Invalid Vector installation identity");
  }
  return `local-board:${installationId}`;
}

export function isLocalBoardUserId(value: string | null | undefined): boolean {
  return value === "local-board" || /^local-board:[a-z][a-z0-9-]{1,63}$/.test(value ?? "");
}
