import { isTradingExecutor } from "./trading-executor.js";

/**
 * Whether this process may run MarketRecorder instances.
 * Live order placers (TRADING_EXECUTOR) never record — toggles still persist per market in Mongo
 * so a separate recorder process can pick them up.
 */
export function canProcessRecord(): boolean {
  return !isTradingExecutor();
}
