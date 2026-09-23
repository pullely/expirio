import type { Env } from "./env.js";
import { route } from "./router.js";
import { runScheduledSweep } from "./sweep.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  /** EX2: the hourly reminder sweep (`25 * * * *`, declared in wrangler.template.jsonc). */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledSweep(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
