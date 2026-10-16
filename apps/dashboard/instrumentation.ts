// Runs once when the Next.js server starts: opens the database and starts the WhatsApp worker, so queued
// messages are answered even before anyone opens the dashboard.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { services } = await import("./lib/services");
  await services();
}
