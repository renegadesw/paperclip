import { createHash } from "node:crypto";

export interface VectorIngressOwnerIdentity {
  companyId: string;
  agentId: string;
  ownerId: string;
  installationId: string;
  profileId: string;
}

/**
 * The durable owner binding of one Vector conversation, echoed on every
 * ingress reply. Values come from the stored mapping, never from the request,
 * so Vector OS can recompute the digest from its own authenticated owner and
 * refuse a reply that resolved a different owner's conversation.
 */
export interface VectorIngressOwnerBinding {
  ownerSha256: string;
  externalSessionId: string;
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
