import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { selfHostedBrokerRelayPath } from "@paperclipai/shared";
import { createPaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";

/**
 * A self-hosted (loopback) connector broker, e.g. Vector OS serving github.code
 * as its GitHub App installation: sign-in completes on the board's origin
 * without a provider trip, and the sealed credential names its installation.
 */

const INSTANCE = "11111111-2222-3333-4444-555555555555";

function rawPrivate(key: KeyObject): string {
  return (key.export({ format: "jwk" }) as { d: string }).d;
}
function rawPublic(key: KeyObject): Buffer {
  return Buffer.from((key.export({ format: "jwk" }) as { x: string }).x, "base64url");
}

const sign = generateKeyPairSync("ed25519");
const seal = generateKeyPairSync("x25519");

function connector(baseUrl: string, respond: (path: string, body: Record<string, unknown>) => unknown) {
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(respond(url.pathname, body)), {
      headers: { "content-type": "application/json" },
    });
  });
  return {
    request,
    client: createPaperclipCloudConnector({
      config: {
        baseUrl,
        instanceId: INSTANCE,
        environment: "production",
        signPrivateKey: rawPrivate(sign.privateKey),
        sealPrivateKey: rawPrivate(seal.privateKey),
      },
      request,
    }),
  };
}

/** The broker's sealing, byte-for-byte what the client's decryptor expects. */
function sealed(purpose: "initial" | "access", plaintext: Record<string, unknown>) {
  const ephemeral = generateKeyPairSync("x25519");
  const epk = rawPublic(ephemeral.publicKey);
  const recipient = rawPublic(createPublicKey(seal.privateKey));
  const aad = Buffer.from(["1", "X25519-HKDF-SHA256-A256GCM", purpose, INSTANCE, "production", "github", "github.code", ""].join("\n"), "utf8");
  const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: ephemeral.privateKey, publicKey: seal.publicKey }), Buffer.concat([epk, recipient]), aad, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1, alg: "X25519-HKDF-SHA256-A256GCM", purpose, provider: "github", profile: "github.code",
    epk: epk.toString("base64url"), iv: iv.toString("base64url"), ct: ct.toString("base64url"),
  };
}

function installationCredentials(extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    accessToken: "ghs_installation",
    refreshToken: "vcb1.handle.mac",
    tokenType: "bearer",
    accessTokenExpiresAt: "2026-09-28T13:00:00.000Z",
    refreshTokenExpiresAt: null,
    scopes: [],
    subject: "agent:funkydev",
    companyId: "company-1",
    instanceId: INSTANCE,
    environment: "production",
    provider: "github",
    profile: "github.code",
    appSlug: "renegade-agents",
    installationId: "155009613",
    ...extra,
  };
}

const RELAY = "/__connector/oauth/github/callback?state=broker-state-abc";

function session(authorizationUrl: string, baseUrl: string) {
  return {
    confirmationUrl: `${baseUrl}/connections/confirm?session=s`,
    authorizationUrl,
    expiresAt: "2026-09-28T12:10:00.000Z",
  };
}

const start = {
  subject: "agent:funkydev",
  companyId: "company-1",
  profile: "github.code" as const,
  returnUri: "http://127.0.0.1:3100/api/tools/oauth/cloud-connector/callback",
  returnState: "paperclip-state",
};

describe("self-hosted connector broker", () => {
  it("returns a loopback broker's same-origin relay path as the browser URL", async () => {
    const { client } = connector("http://127.0.0.1:4567", () => session(RELAY, "http://127.0.0.1:4567"));
    await expect(client.startAuthorization(start)).resolves.toMatchObject({ authorizationUrl: RELAY });
  });

  it("never accepts a relative browser URL from a Paperclip Cloud broker", async () => {
    const { client } = connector("https://my.paperclip.app", () => session(RELAY, "https://my.paperclip.app"));
    await expect(client.startAuthorization(start)).rejects.toMatchObject({ code: "CONNECTOR_BAD_RESPONSE" });
  });

  it.each([
    "//evil.example/__connector/x",
    "/__connector//evil.example",
    "/__connector/../api/companies",
    "/__connector/%2e%2e/api/companies",
    "/__connector\\evil",
    "/__connector/x#frag",
    "/__connector/x y",
    "/elsewhere/oauth/github/callback",
    "__connector/oauth/github/callback",
    "http://127.0.0.1:4567/__connector/oauth/github/callback",
    "https://evil.example/__connector/oauth/github/callback",
  ])("rejects %s from a loopback broker", async (authorizationUrl) => {
    const { client } = connector("http://127.0.0.1:4567", () => session(authorizationUrl, "http://127.0.0.1:4567"));
    await expect(client.startAuthorization(start)).rejects.toMatchObject({ code: "CONNECTOR_BAD_RESPONSE" });
  });

  it("still accepts GitHub's own authorization URL from a loopback broker", async () => {
    const provider = "https://github.com/login/oauth/authorize?client_id=Iv23&state=s";
    const { client } = connector("http://127.0.0.1:4567", () => session(provider, "http://127.0.0.1:4567"));
    await expect(client.startAuthorization(start)).resolves.toMatchObject({ authorizationUrl: provider });
  });

  it("opens an installation credential and keeps its installation id", async () => {
    const { client } = connector("http://127.0.0.1:4567", () => ({ sealed: sealed("initial", installationCredentials()) }));
    const credentials = await client.claim({ subject: "agent:funkydev", companyId: "company-1", profile: "github.code", claimId: "c", redemptionId: "r" });
    expect(credentials).toMatchObject({
      accessToken: "ghs_installation",
      tokenType: "bearer",
      refreshTokenExpiresAt: null,
      appSlug: "renegade-agents",
      installationId: "155009613",
    });
  });

  it("tolerates a credential without an installation id (user tokens)", async () => {
    const { installationId: _omitted, ...userCredentials } = installationCredentials({ accessToken: "ghu_user" });
    const { client } = connector("http://127.0.0.1:4567", () => ({ sealed: sealed("access", userCredentials) }));
    const credentials = await client.refresh({ subject: "agent:funkydev", companyId: "company-1", profile: "github.code", refreshToken: "ghr" });
    expect(credentials.installationId).toBeUndefined();
  });

  it.each(["0", "abc", 155009613, ""])("rejects a malformed installation id %s", async (installationId) => {
    const { client } = connector("http://127.0.0.1:4567", () => ({ sealed: sealed("initial", installationCredentials({ installationId })) }));
    await expect(client.claim({ subject: "agent:funkydev", companyId: "company-1", profile: "github.code", claimId: "c", redemptionId: "r" })).rejects.toMatchObject({ code: "CONNECTOR_BAD_RESPONSE" });
  });
});

describe("selfHostedBrokerRelayPath", () => {
  it("normalizes only rooted paths under /__connector/", () => {
    expect(selfHostedBrokerRelayPath(RELAY)).toBe(RELAY);
    expect(selfHostedBrokerRelayPath("/__connector/a/./b?x=1")).toBe("/__connector/a/b?x=1");
    expect(selfHostedBrokerRelayPath("/__connector/a/../../api")).toBeUndefined();
    expect(selfHostedBrokerRelayPath("/__connectorx/a")).toBeUndefined();
    expect(selfHostedBrokerRelayPath(`/__connector/${"a".repeat(2100)}`)).toBeUndefined();
  });
});
