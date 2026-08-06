// testConnection helper for the ClawRent channel setup surface (the
// createChannelPluginBase `setup.testConnection` adapter in index.ts).
// Uses @clawrent/provider's ApiClient (same package that drives the runtime).
//
// History: this module was previously referenced by package.json
// `openclaw.setupEntry`; that field was removed because the OpenClaw loader
// validated the setupEntry module with the full-plugin register/activate check
// (which this named-export helper legitimately lacks), falsely rejecting the
// plugin at startup. The setup adapter on the channel plugin now covers it.
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
