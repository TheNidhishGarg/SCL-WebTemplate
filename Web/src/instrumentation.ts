// Runs once per server start. Validating here means a misconfigured deploy
// fails at boot with a list of what is wrong, not on the first request that
// happens to touch a provider.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("@/server/env");
    const env = getEnv();
    const on = Object.entries(env.integrations)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    console.info(`[env] ok (${env.NODE_ENV}); integrations enabled: ${on.length ? on.join(", ") : "none"}`);
  }
}
