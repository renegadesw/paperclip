/**
 * Vector installation profiles that run the Funky server product: the
 * Funky analyst, Scout and Advisor roster, the sealed workload catalog,
 * schedule routines, role turns and the `funky` legacy Pi service.
 *
 * `staging` (stg1) and `production` (prod1) are the same product and differ
 * only in installation identity. Installation isolation keys on
 * installationId, never on the profile, so two Funky server installations
 * never see each other's rows.
 */
export const VECTOR_FUNKY_SERVER_PROFILES = ["staging", "production"] as const;

export type VectorFunkyServerProfile = (typeof VECTOR_FUNKY_SERVER_PROFILES)[number];

export function isVectorFunkyServerProfile(profile: string | null | undefined): profile is VectorFunkyServerProfile {
  return profile === "staging" || profile === "production";
}
