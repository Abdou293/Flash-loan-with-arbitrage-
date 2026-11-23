import { crossDex } from "./crossDex.js";
import { feeTier } from "./feeTier.js";
import { newPoolScanner } from "./newPoolScanner.js";
import { triangular } from "./triangular.js";
import type { Strategy } from "./Strategy.js";

/** Every available strategy module. Enabled/disabled via strategies.config.json. */
export const ALL_STRATEGIES: Record<string, Strategy> = {
  crossDex,
  triangular,
  feeTier,
  newPoolScanner,
};
