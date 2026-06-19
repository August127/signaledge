import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LastPriceAnimationMode,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
} from "lightweight-charts";

const TIMEFRAME_SECONDS = { D1: 86400, H4: 14400 };
const TV_GREEN = "#0ecb81";
const TV_RED = "#f6465d";
const CRYSTAL_BULL = "#2196f3";
const CRYSTAL_BEAR = "#f59e0b";
const RANGE_DAYS = { "7D": 7, "1M": 30, "3M": 90 };
const RANGE_SPACING = { "7D": 4.8, "1M": 3.2, "3M": 2.05 };
const OVERVIEW_RIGHT_BARS = { D1: 7, H4: 18 };

function priceFormatFor(rows) {
  const last = rows.at(-1)?.close ?? 0;
  if (last < 1) return { type: "price", precision: 5, minMove: 0.00001 };
  if (last < 10) return { type: "price", precision: 4, minMove: 0.0001 };
  if (last < 100) return { type: "price", precision: 2, minMove: 0.01 };
  return { type: "price", precision: 2, minMove: 0.01 };
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "";
  return value >= 1000
    ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 5 : 2 });
}

function displayRangeDays(dateRange) {
  return RANGE_DAYS[dateRange] ?? null;
}

function targetBarsForRange(timeframe, dateRange) {
  const days = displayRangeDays(dateRange) ?? RANGE_DAYS["3M"];
  return timeframe === "H4" ? Math.ceil((days * 24) / 4) : days;
}

function applyOverviewRange(chart, rows, timeframe, dateRange) {
  const last = rows.at(-1);
  if (!last) return;
  const targetBars = Math.max(20, targetBarsForRange(timeframe, dateRange));
  const visibleBars = Math.min(rows.length, targetBars);
  const first = rows.at(-visibleBars);
  const seconds = TIMEFRAME_SECONDS[timeframe] ?? 86400;
  const rightOffset = OVERVIEW_RIGHT_BARS[timeframe] ?? 10;
  chart.timeScale().applyOptions({
    barSpacing: RANGE_SPACING[dateRange] ?? RANGE_SPACING["3M"],
    minBarSpacing: 0.8,
    rightOffset,
  });
  chart.timeScale().setVisibleRange({
    from: first.time,
    to: last.time + seconds * rightOffset,
  });
}

export function TradingChart({ analysis, layers, dateRange = "3M", lockedPreview = false, signalMode = "confirmed" }) {
  const containerRef = useRef(null);
  const zoneRef = useRef(null);

  useEffect(() => {
    if (!analysis || !containerRef.current) return undefined;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      autoSize: true,
      layout: {
        attributionLogo: false,
        background: { type: ColorType.Solid, color: "#070d16" },
        textColor: "#d6e4f0",
        fontFamily: "Inter, Segoe UI, Arial, sans-serif",
        fontSize: 12,
      },
      localization: {
        locale: "en-US",
        priceFormatter: formatPrice,
      },
      grid: {
        vertLines: { color: "rgba(70, 96, 128, 0.22)", style: LineStyle.Solid },
        horzLines: { color: "rgba(70, 96, 128, 0.24)", style: LineStyle.Solid },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: "#22d3ff", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#12345a" },
        horzLine: { color: "#22d3ff", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#12345a" },
      },
      rightPriceScale: {
        visible: true,
        borderVisible: true,
        borderColor: "#183456",
        autoScale: true,
        entireTextOnly: true,
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: {
        borderVisible: true,
        borderColor: "#183456",
        timeVisible: analysis.timeframe !== "D1",
        secondsVisible: false,
        rightOffset: OVERVIEW_RIGHT_BARS[analysis.timeframe] ?? (lockedPreview ? 10 : 8),
        barSpacing: RANGE_SPACING[dateRange] ?? 4,
        minBarSpacing: 0.8,
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: false,
        rightBarStaysOnScroll: true,
        shiftVisibleRangeOnNewBar: true,
      },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: TV_GREEN,
      downColor: TV_RED,
      wickUpColor: "rgba(14, 203, 129, 0.92)",
      wickDownColor: "rgba(246, 70, 93, 0.92)",
      borderUpColor: "rgba(14, 203, 129, 0.95)",
      borderDownColor: "rgba(246, 70, 93, 0.95)",
      borderVisible: true,
      priceFormat: priceFormatFor(analysis.rows),
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineColor: "#22d3ff",
      priceLineStyle: LineStyle.Dotted,
      lastPriceAnimation: LastPriceAnimationMode.OnDataUpdate,
    });
    const candleRows = layers.ha ? analysis.haRows : analysis.rows;
    const candleData = candleRows.map((row, index) => {
      const bullish = row.close >= row.open;
      const color = layers.ha
        ? (analysis.haRows[index]?.direction === "bull" ? CRYSTAL_BULL : CRYSTAL_BEAR)
        : (bullish ? TV_GREEN : TV_RED);
      return {
        time: row.time,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        color,
        wickColor: color,
        borderColor: color,
      };
    });
    candles.setData(candleData);

    if (layers.ema) {
      [[analysis.ema20, "#22d3ff", 2], [analysis.ema50, "#1e88ff", 2], [analysis.ema200, "#8b7cf6", 1]].forEach(([values, color, lineWidth]) => {
        const series = chart.addSeries(LineSeries, { color, lineWidth, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        series.setData(values.map((value, index) => ({ time: analysis.rows[index].time, value })));
      });
    }

    if (layers.atr && analysis.atrBands) {
      [[analysis.atrBands.upper, "#b8860b"], [analysis.atrBands.lower, "#b8860b"]].forEach(([values, color]) => {
        const series = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        series.setData(values.map((value, index) => ({ time: analysis.rows[index].time, value })));
      });
    }

    const markers = [];
    if (layers.crystal) {
      analysis.crystal
        .filter((event) => event.type !== "expired")
        .filter((event) => signalMode === "aggressive" || event.type === "arrow")
        .slice(-12)
        .forEach((event) => {
        const bullish = event.direction === "bull";
        markers.push({
          time: event.time,
          position: bullish ? "belowBar" : "aboveBar",
          shape: event.type === "circle" ? "circle" : bullish ? "arrowUp" : "arrowDown",
          color: event.type === "circle" ? (bullish ? "#1e90ff" : "#f28c28") : (bullish ? "#36d56b" : "#ff4055"),
          text: event.type === "circle" ? "" : bullish ? "BUY" : "SELL",
        });
      });
    }
    if (layers.structure) {
      analysis.structure.events.slice(-4).forEach((event) => markers.push({
        time: event.time, position: event.direction === "bull" ? "aboveBar" : "belowBar", shape: "square",
        color: event.type === "BOS" ? "#a96ce4" : "#ff5b54", text: event.type,
      }));
      const spartan = analysis.spartan?.at(-1);
      if (spartan) {
        [spartan.p1, spartan.p2, spartan.p3].forEach((pivot, index) => markers.push({
          time: pivot.time,
          position: pivot.type === "low" ? "belowBar" : "aboveBar",
          shape: "circle", color: "#62c6ff", text: String(index + 1),
        }));
      }
      analysis.liquiditySweeps?.slice(-1).forEach((event) => markers.push({
        time: event.time, position: event.direction === "bull" ? "belowBar" : "aboveBar",
        shape: "square", color: "#d9b44a", text: "SWEEP",
      }));
    }
    if (lockedPreview && !layers.crystal && !layers.structure) {
      const premiumEvents = [
        ...(analysis.crystal ?? []).filter((event) => event.type !== "expired").slice(-3),
        ...(analysis.structure?.events ?? []).slice(-2),
      ].sort((a, b) => a.time - b.time).slice(-4);
      premiumEvents.forEach((event) => {
        const bullish = event.direction !== "bear";
        markers.push({
          time: event.time,
          position: bullish ? "belowBar" : "aboveBar",
          shape: "circle",
          color: "#22d3ff",
          text: "LOCKED",
        });
      });
    }
    markers.sort((a, b) => a.time - b.time);
    createSeriesMarkers(candles, markers);

    if (layers.orderBlock && analysis.orderBlock) {
      const zone = analysis.orderBlock;
      const color = zone.direction === "bull" ? "#39b873" : "#d94c5b";
      candles.createPriceLine({ price: zone.high, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "OB H" });
      candles.createPriceLine({ price: zone.low, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "OB L" });
    }

    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.79, bottom: 0 } });
    volume.setData(analysis.rows.map((row) => ({ time: row.time, value: row.volume, color: row.close >= row.open ? "rgba(14, 203, 129, 0.34)" : "rgba(246, 70, 93, 0.34)" })));
    applyOverviewRange(chart, analysis.rows, analysis.timeframe, dateRange);

    const updateZone = () => {
      const element = zoneRef.current;
      const zone = layers.orderBlock ? analysis.orderBlock : null;
      if (!element || !zone) {
        if (element) element.style.display = "none";
        return;
      }
      const top = candles.priceToCoordinate(zone.high);
      const bottom = candles.priceToCoordinate(zone.low);
      const origin = chart.timeScale().timeToCoordinate(zone.originTime);
      if (top == null || bottom == null) return;
      element.style.display = "block";
      element.style.top = `${Math.min(top, bottom)}px`;
      element.style.height = `${Math.max(4, Math.abs(bottom - top))}px`;
      element.style.left = `${Math.max(origin ?? 0, containerRef.current.clientWidth * 0.55)}px`;
      element.style.right = "68px";
      element.dataset.direction = zone.direction;
    };
    requestAnimationFrame(updateZone);

    const resize = new ResizeObserver(() => {
      chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      requestAnimationFrame(() => {
        applyOverviewRange(chart, analysis.rows, analysis.timeframe, dateRange);
        updateZone();
      });
    });
    resize.observe(containerRef.current);
    return () => { resize.disconnect(); chart.remove(); };
  }, [analysis, layers, dateRange, lockedPreview, signalMode]);

  return <div className={`trading-chart ${lockedPreview ? "locked-preview" : ""}`} ref={containerRef}>
    <div className="chart-mode-badge">{layers.ha ? "CRYSTAL HA · 3M OVERVIEW" : lockedPreview ? "RAW OHLC · PREMIUM PREVIEW" : "RAW OHLC · 3M OVERVIEW"}</div>
    <div className="chart-watermark"><strong>SignalEdge</strong><span>Where Signals Become Edge</span></div>
    {lockedPreview && <div className="premium-preview-card">
      <span>PREMIUM SIGNAL LAYER</span>
      <strong>Scanner A+ / Crystal / BOS đang khóa</strong>
      <p>Các điểm LOCKED là tín hiệu thật đã được ẩn chi tiết. Nâng gói Signal để xem score, căn cứ, entry/SL/TP và alert Telegram.</p>
    </div>}
    <div className="chart-zone" ref={zoneRef} />
  </div>;
}
