(function (global) {
  function normalizeAssetPriceMode(raw) {
    const value = String(raw ?? "").trim().toLowerCase();
    if (value === "twap30" || value === "30" || value === "twap_30") return "twap30";
    if (value === "twap60" || value === "60" || value === "twap_60") return "twap60";
    if (value === "twap") return "twap30";
    return "raw";
  }

  function twapLookbackSecondsForMode(mode) {
    const normalized = normalizeAssetPriceMode(mode);
    if (normalized === "twap30") return 30;
    if (normalized === "twap60") return 60;
    return null;
  }

  function twapLookbackSecondsForTimeframe(timeframe) {
    return String(timeframe || "").toLowerCase() === "15m" ? 60 : 30;
  }

  function twapLookbackSecondsForSeries(series) {
    const tf = String(series || "").split("-")[1] || "";
    return twapLookbackSecondsForTimeframe(tf);
  }

  function computeTwapAt(samples, atMs, windowMs) {
    if (!Number.isFinite(atMs) || !Number.isFinite(windowMs) || windowMs <= 0) {
      return undefined;
    }
    const pts = (samples || [])
      .filter((s) => s && Number.isFinite(s.tMs) && Number.isFinite(s.price))
      .slice()
      .sort((a, b) => a.tMs - b.tMs);
    if (pts.length === 0) return undefined;

    const startMs = atMs - windowMs;
    let carry;
    for (const p of pts) {
      if (p.tMs <= startMs) carry = p.price;
      else break;
    }

    const segs = [];
    if (carry != null) segs.push({ tMs: startMs, price: carry });
    for (const p of pts) {
      if (p.tMs <= startMs) continue;
      if (p.tMs > atMs) break;
      segs.push(p);
    }
    if (segs.length === 0) {
      const last = pts[pts.length - 1];
      return last.tMs <= atMs ? last.price : undefined;
    }

    let area = 0;
    let covered = 0;
    for (let i = 0; i < segs.length; i += 1) {
      const from = Math.max(segs[i].tMs, startMs);
      const to = i + 1 < segs.length ? segs[i + 1].tMs : atMs;
      const dt = to - from;
      if (dt <= 0) continue;
      area += segs[i].price * dt;
      covered += dt;
    }
    if (covered <= 0) return segs[segs.length - 1].price;
    return area / covered;
  }

  function roundPrice(value) {
    if (value == null || !Number.isFinite(value)) return undefined;
    return Math.round(value * 100) / 100;
  }

  function applyTwapToPriceHistory(history, lookbackSec) {
    const windowMs = Math.max(1, lookbackSec) * 1000;
    const list = Array.isArray(history) ? history : [];
    const samples = list
      .filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.price))
      .map((p) => ({ tMs: p.t * 1000, price: p.price }));
    if (samples.length === 0) return list;
    return list.map((point) => {
      const twap = roundPrice(computeTwapAt(samples, point.t * 1000, windowMs));
      if (twap == null) return point;
      return { t: point.t, price: twap };
    });
  }

  function applyTwapToReplayTicks(ticks, lookbackSec) {
    const windowMs = Math.max(1, lookbackSec) * 1000;
    const list = Array.isArray(ticks) ? ticks : [];
    const samples = [];
    for (const tick of list) {
      if (tick?.assetPrice == null || !Number.isFinite(tick.assetPrice)) continue;
      samples.push({ tMs: tick.tMs, price: tick.assetPrice });
    }
    if (samples.length === 0) return list;
    return list.map((tick) => {
      if (tick?.assetPrice == null || !Number.isFinite(tick.assetPrice)) return tick;
      const twap = roundPrice(computeTwapAt(samples, tick.tMs, windowMs));
      if (twap == null) return tick;
      const next = { ...tick, assetPrice: twap };
      if (tick.prevCloseAsset != null && Number.isFinite(tick.prevCloseAsset)) {
        next.assetGap = twap - tick.prevCloseAsset;
      }
      return next;
    });
  }

  global.AssetPriceMode = {
    normalizeAssetPriceMode,
    twapLookbackSecondsForMode,
    twapLookbackSecondsForTimeframe,
    twapLookbackSecondsForSeries,
    computeTwapAt,
    applyTwapToPriceHistory,
    applyTwapToReplayTicks,
  };
})(window);
