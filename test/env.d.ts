import type { Bindings } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}
