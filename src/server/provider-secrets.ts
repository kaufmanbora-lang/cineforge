import "server-only";
import type { EncryptedSecret } from "./key-vault";
import { decryptSecret, encryptSecret, keyHint } from "./key-vault";
import { env } from "./env";
import { query } from "./db";

type Provider = "google" | "openai";

interface SecretRow {
  encrypted_value: EncryptedSecret;
  key_hint: string;
  status: string;
  metadata: Record<string, unknown>;
  last_checked_at: string | null;
}

export async function getProviderKey(provider: Provider, workspaceId = env().DEFAULT_WORKSPACE_ID): Promise<string | null> {
  try {
    const rows = await query<SecretRow>(
      "SELECT encrypted_value, key_hint, status, metadata, last_checked_at FROM provider_secrets WHERE workspace_id = $1 AND provider = $2",
      [workspaceId, provider],
    );
    if (rows[0]) return decryptSecret(rows[0].encrypted_value);
  } catch {
    // Environment keys keep the app usable while infrastructure is being provisioned.
  }
  return provider === "google" ? env().GEMINI_API_KEY ?? null : env().OPENAI_API_KEY ?? null;
}

export async function saveProviderKey(provider: Provider, key: string, workspaceId = env().DEFAULT_WORKSPACE_ID): Promise<void> {
  const encrypted = encryptSecret(key);
  await query(
    `INSERT INTO provider_secrets (workspace_id, provider, encrypted_value, key_hint, status)
     VALUES ($1, $2, $3, $4, 'untested')
     ON CONFLICT (workspace_id, provider) DO UPDATE
     SET encrypted_value = EXCLUDED.encrypted_value, key_hint = EXCLUDED.key_hint,
         status = 'untested', metadata = '{}'::jsonb, last_checked_at = NULL`,
    [workspaceId, provider, JSON.stringify(encrypted), keyHint(key)],
  );
}

export async function providerStatus(provider: Provider, workspaceId = env().DEFAULT_WORKSPACE_ID): Promise<{
  configured: boolean;
  source: "vault" | "environment" | "none";
  hint: string | null;
  status: string;
  metadata: Record<string, unknown>;
  lastCheckedAt: string | null;
}> {
  try {
    const rows = await query<SecretRow>(
      "SELECT encrypted_value, key_hint, status, metadata, last_checked_at FROM provider_secrets WHERE workspace_id = $1 AND provider = $2",
      [workspaceId, provider],
    );
    if (rows[0]) {
      return {
        configured: true,
        source: "vault",
        hint: rows[0].key_hint,
        status: rows[0].status,
        metadata: rows[0].metadata,
        lastCheckedAt: rows[0].last_checked_at,
      };
    }
  } catch {
    // Report the environment fallback without disclosing its value.
  }
  const configured = provider === "google" ? Boolean(env().GEMINI_API_KEY) : Boolean(env().OPENAI_API_KEY);
  return {
    configured,
    source: configured ? "environment" : "none",
    hint: configured ? "•••• environment" : null,
    status: configured ? "available" : "missing",
    metadata: {},
    lastCheckedAt: null,
  };
}

export async function updateProviderStatus(
  provider: Provider,
  status: "connected" | "failed",
  metadata: Record<string, unknown>,
  workspaceId = env().DEFAULT_WORKSPACE_ID,
): Promise<void> {
  await query(
    "UPDATE provider_secrets SET status = $3, metadata = $4, last_checked_at = now() WHERE workspace_id = $1 AND provider = $2",
    [workspaceId, provider, status, JSON.stringify(metadata)],
  );
}
