import { describe, expect, it, vi } from "vitest";
import {
  isCloudPinnedPrimaryCompany,
  notifyCloudOfPrimaryCompanyLifecycleChange,
} from "../services/cloud-lifecycle-sync.js";
import { cloudTenantPrimaryCompanyId } from "../services/cloud-instance.js";

const STACK_ID = "stack-lifecycle-sync";
const PRIMARY_ID = cloudTenantPrimaryCompanyId(STACK_ID);

const CLOUD_ENV = {
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-token-test",
  PAPERCLIP_CLOUD_STACK_ID: STACK_ID,
  PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test",
} as NodeJS.ProcessEnv;

describe("isCloudPinnedPrimaryCompany", () => {
  it("matches only the derived primary company of a cloud-managed instance", () => {
    expect(isCloudPinnedPrimaryCompany(PRIMARY_ID, CLOUD_ENV)).toBe(true);
    expect(isCloudPinnedPrimaryCompany("some-other-company", CLOUD_ENV)).toBe(false);
    // Self-hosted: no cloud signal, never primary.
    expect(isCloudPinnedPrimaryCompany(PRIMARY_ID, {} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("notifyCloudOfPrimaryCompanyLifecycleChange", () => {
  it.each([CLOUD_ENV, {}, { ...CLOUD_ENV, PAPERCLIP_CLOUD_API_ORIGIN: "http://127.0.0.1:9999" }])(
    "never contacts a control plane or schedules retries", async (env) => {
      const fetchImpl = vi.fn();
      const sleep = vi.fn();
      await expect(notifyCloudOfPrimaryCompanyLifecycleChange(PRIMARY_ID, { env, fetchImpl, sleep })).resolves.toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});
