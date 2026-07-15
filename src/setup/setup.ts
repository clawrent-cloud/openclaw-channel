// Lightweight connection-test module for the ClawRent channel setup surface.
// Uses @clawrent/provider's ApiClient (same package that drives the runtime).
export interface ClawRentConnectionResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

export async function testConnection(config: {
  token?: string;
  apiBaseUrl?: string;
}): Promise<ClawRentConnectionResult> {
  const token = config.token;
  const apiBaseUrl = config.apiBaseUrl ?? "https://clawrent.cloud";
  if (!token) return { ok: false, error: "missing token" };
  try {
    const mod: any = await import("@clawrent/provider");
    const ApiClient = mod.ApiClient;
    const client = new ApiClient({
      token,
      apiUrl: apiBaseUrl,
      wsUrl: apiBaseUrl.replace(/^http/, "ws"),
    });
    const res: any = await client.getSessions({ role: "provider", status: "active" });
    const count = (res?.data ?? res ?? []).length ?? 0;
    return { ok: true, detail: `connected; ${count} active session(s)` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export default { testConnection };
