import {
  cloudTenantPrimaryCompanyId,
  getCloudStackContext,
  type CloudInstanceEnv,
} from "./cloud-instance.js";

export type CloudLifecycleSyncOptions = {
  env?: CloudInstanceEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * True when this company is the Cloud-pinned primary company of a managed
 * instance — the only company whose archive state the harness mirrors.
 */
export function isCloudPinnedPrimaryCompany(
  companyId: string,
  env: CloudInstanceEnv = process.env,
): boolean {
  const stackId = getCloudStackContext(env)?.stackId;
  return Boolean(stackId) && cloudTenantPrimaryCompanyId(stackId!) === companyId;
}

/** Paperclip Cloud lifecycle notification is permanently disabled in Vector. */
export async function notifyCloudOfPrimaryCompanyLifecycleChange(
  _companyId: string,
  _options: CloudLifecycleSyncOptions = {},
): Promise<void> {}
