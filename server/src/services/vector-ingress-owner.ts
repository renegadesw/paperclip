import { createHash } from "node:crypto";

export interface VectorIngressOwnerIdentity {
  companyId: string;
  agentId: string;
  ownerId: string;
  installationId: string;
  profileId: string;
}

export function vectorIngressOwnerSha256(input: VectorIngressOwnerIdentity): string {
  return createHash("sha256")
    .update("paperclip-vector-ingress-owner/v1\0")
    .update(input.companyId)
    .update("\0")
    .update(input.agentId)
    .update("\0")
    .update(input.installationId.trim())
    .update("\0")
    .update(input.profileId.trim())
    .update("\0")
    .update(input.ownerId.trim())
    .digest("hex");
}
