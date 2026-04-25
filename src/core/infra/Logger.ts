import type { Logger } from "../../types.js";

const noop = (): void => undefined;

/** Default logger: swallows everything. Hosts supply their own via options.logger. */
export const noopLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};
