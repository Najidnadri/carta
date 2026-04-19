import type { Logger } from "../types.js";

/** Default logger: swallows everything. Hosts supply their own via options.logger. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
