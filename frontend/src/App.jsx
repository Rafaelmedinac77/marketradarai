import { useEffect, useMemo, useRef, useState } from "react"
import { createChart, CandlestickSeries, HistogramSeries } from "lightweight-charts"

const MARKET_URL = "https://n8n-production-d92c1.up.railway.app/webhook/market-data"

const CACHE_TTL = 60 * 1000
const AUTO_REFRESH_MS = 60 * 1000

const defaultWatchlist = [
  { symbol: "NVDA", name: "NVIDIA", price: 214.83 },
  { symbol: "AAPL", name: "Apple", price: 308.38 },
  { symbol: "MSFT", name: "Microsoft", price: 416.15 },
  { symbol: "TSLA", name: "Tesla", price: 433.56 },
  { symbol: "META", name: "Meta Platforms", price: 612.34 },
  { symbol: "AMZN", name: "Amazon", price: 265.31 },
]

const names = {
  NVDA: "NVIDIA",
  AAPL: "Apple",
  MSFT: "Microsoft",
  TSLA: "Tesla",
  META: "Meta Platforms",
  AMZN: "Amazon",
  AMD: "AMD",
  NFLX: "Netflix",
  PLTR: "Palantir",
  GOOGL: "Alphabet",
}

function getTimeframeConfig(timeframe) {
  if (timeframe === "5D") return { interval: "4h", outputsize: 30 }
  if (timeframe === "1M") return { interval: "1day", outputsize: 30 }
  return { interval: "1h", outputsize: 24 }
}

function parseChartTime(value) {
  if (!value) return Math.floor(Date.now() / 1000)
  const normalized = String(value).replace(" ", "T")
  const timestamp = Math.floor(new Date(normalized).getTime() / 1000)
  return Number.isFinite(timestamp) ? timestamp : Math.floor(Date.now() / 1000)
}

function formatChartDate(value) {
  const date = new Date(Number(value) * 1000)
  if (!Number.isFinite(date.getTime())) return ""

  return date.toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatVolume(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return "0"
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(2)}K`
  return number.toFixed(0)
}

function calculateEMA(data, period) {
  if (!data.length) return []

  const multiplier = 2 / (period + 1)
  const ema = []
  let previousEMA = Number(data[0].close)

  data.forEach((item, index) => {
    const close = Number(item.close)

    if (index === 0) {
      ema.push(previousEMA)
      return
    }

    const currentEMA = (close - previousEMA) * multiplier + previousEMA
    ema.push(currentEMA)
    previousEMA = currentEMA
  })

  return ema
}

function calculateRSI(data, period = 14) {
  if (data.length < period + 1) return 50

  let gains = 0
  let losses = 0

  for (let i = 1; i <= period; i++) {
    const diff = Number(data[i].close) - Number(data[i - 1].close)
    if (diff >= 0) gains += diff
    else losses += Math.abs(diff)
  }

  const avgGain = gains / period
  const avgLoss = losses / period

  if (avgLoss === 0) return 100

  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function readCache(key, ttl) {
  try {
    const cached = localStorage.getItem(key)
    if (!cached) return null

    const parsed = JSON.parse(cached)
    if (Date.now() - parsed.timestamp > ttl) return null

    return parsed.data
  } catch {
    return null
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        timestamp: Date.now(),
        data,
      })
    )
  } catch {
    // no bloquear app
  }
}

function App() {
  const [selectedSymbol, setSelectedSymbol] = useState("NVDA")
  const [chartData, setChartData] = useState([])
  const [watchlist, setWatchlist] = useState(defaultWatchlist)
  const [timeframe, setTimeframe] = useState("1D")
  const [liveMode, setLiveMode] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState("Modo seguro: sin consumo API")
  const [lastUpdated, setLastUpdated] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [newSymbol, setNewSymbol] = useState("")

  const chartContainerRef = useRef(null)

  const selectedAsset = watchlist.find((item) => item.symbol === selectedSymbol)
  const selectedPrice = chartData[chartData.length - 1]?.close || selectedAsset?.price || 0

  const ema20 = useMemo(() => calculateEMA(chartData, 20), [chartData])
  const ema50 = useMemo(() => calculateEMA(chartData, 50), [chartData])
  const rsi = useMemo(() => calculateRSI(chartData), [chartData])

  const currentEMA20 = ema20.length ? ema20[ema20.length - 1].toFixed(2) : "--"
  const currentEMA50 = ema50.length ? ema50[ema50.length - 1].toFixed(2) : "--"

  const technicalSignal = useMemo(() => {
    if (!chartData.length) return "Esperando datos"

    const lastClose = Number(chartData[chartData.length - 1].close)
    const emaFast = Number(currentEMA20)
    const emaSlow = Number(currentEMA50)

    if (rsi > 70) return "Sobrecompra"
    if (rsi < 30) return "Sobreventa"
    if (lastClose > emaFast && emaFast > emaSlow) return "Tendencia alcista"
    if (lastClose < emaFast && emaFast < emaSlow) return "Tendencia bajista"

    return "Neutral"
  }, [chartData, currentEMA20, currentEMA50, rsi])

  const topGainer = watchlist.reduce((prev, current) =>
    Number(current.price) > Number(prev.price) ? current : prev
  )

  const topLoser = watchlist.reduce((prev, current) =>
    Number(current.price) < Number(prev.price) ? current : prev
  )

  const loadMarketData = async ({ force = false } = {}) => {
    const cacheKey = `market-${selectedSymbol}-${timeframe}`

    if (!force) {
      const cachedData = readCache(cacheKey, CACHE_TTL)

      if (cachedData) {
        setChartData(cachedData)
        setConnectionStatus(`Cache local - ${selectedSymbol} / ${timeframe}`)
        return
      }
    }

    if (!liveMode && !force) {
      setConnectionStatus("Modo seguro: no se consulta API")
      return
    }

    try {
      setIsLoading(true)
      setConnectionStatus(`LIVE: cargando ${selectedSymbol}...`)

      const { interval, outputsize } = getTimeframeConfig(timeframe)

      const response = await fetch(
        `${MARKET_URL}?symbol=${selectedSymbol}&interval=${interval}&outputsize=${outputsize}`
      )

      const text = await response.text()
      if (!text) throw new Error("Respuesta vacía desde n8n")

      const data = JSON.parse(text)

      if (!data.chartData || !Array.isArray(data.chartData)) {
        throw new Error("chartData no válido")
      }

      const formattedChart = data.chartData
        .filter(
          (item) =>
            item.hora &&
            item.open !== undefined &&
            item.high !== undefined &&
            item.low !== undefined &&
            item.close !== undefined &&
            !isNaN(Number(item.close))
        )
        .map((item) => ({
          time: String(item.hora),
          open: Number(item.open),
          high: Number(item.high),
          low: Number(item.low),
          close: Number(item.close),
          price: Number(item.close),
          volume: Number(item.volume || 0),
        }))

      setChartData(formattedChart)
      writeCache(cacheKey, formattedChart)

      const lastClose = formattedChart[formattedChart.length - 1]?.close || 0

      setWatchlist((prev) =>
        prev.map((item) =>
          item.symbol === selectedSymbol
            ? { ...item, price: Number(lastClose) }
            : item
        )
      )

      setLastUpdated(new Date())
      setConnectionStatus(`LIVE conectado - ${selectedSymbol} / ${timeframe}`)
    } catch (error) {
      console.error(error)
      setConnectionStatus("Error cargando datos desde n8n")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadMarketData()
  }, [selectedSymbol, timeframe, liveMode, refreshKey])

  useEffect(() => {
    if (!liveMode) return

    const interval = setInterval(() => {
      loadMarketData({ force: true })
    }, AUTO_REFRESH_MS)

    return () => clearInterval(interval)
  }, [liveMode, selectedSymbol, timeframe])

  useEffect(() => {
    if (!chartContainerRef.current) return

    chartContainerRef.current.innerHTML = ""

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 500,
      layout: {
        background: { color: "#111827" },
        textColor: "#94a3b8",
      },
      grid: {
        vertLines: { color: "#1e293b" },
        horzLines: { color: "#1e293b" },
      },
      rightPriceScale: {
        borderColor: "#334155",
        scaleMargins: {
          top: 0.1,
          bottom: 0.25,
        },
      },
      timeScale: {
        borderColor: "#334155",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => formatChartDate(time),
      },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceFormat: {
        type: "custom",
        formatter: (price) => `$${Number(price).toFixed(2)}`,
      },
    })

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: {
        type: "custom",
        formatter: (price) => formatVolume(price),
      },
      priceScaleId: "",
    })

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.78,
        bottom: 0,
      },
    })

    const candleData = chartData.map((item) => ({
      time: parseChartTime(item.time),
      open: Number(Number(item.open).toFixed(2)),
      high: Number(Number(item.high).toFixed(2)),
      low: Number(Number(item.low).toFixed(2)),
      close: Number(Number(item.close).toFixed(2)),
    }))

    const volumeData = chartData.map((item) => ({
      time: parseChartTime(item.time),
      value: Number(item.volume || 0),
      color:
        Number(item.close) >= Number(item.open)
          ? "rgba(34, 197, 94, 0.45)"
          : "rgba(239, 68, 68, 0.45)",
    }))

    if (candleData.length > 0) {
      candleSeries.setData(candleData)
      volumeSeries.setData(volumeData)
      chart.timeScale().fitContent()
    }

    const handleResize = () => {
      if (!chartContainerRef.current) return
      chart.applyOptions({
        width: chartContainerRef.current.clientWidth,
      })
    }

    window.addEventListener("resize", handleResize)

    return () => {
      window.removeEventListener("resize", handleResize)
      chart.remove()
    }
  }, [chartData])

  const handleSymbolClick = (symbol) => {
    setSelectedSymbol(symbol)
    setLiveMode(true)
    setRefreshKey((prev) => prev + 1)
  }

  const handleTimeframeClick = (item) => {
    setTimeframe(item)
    setLiveMode(true)
    setRefreshKey((prev) => prev + 1)
  }

  const forceLiveRefresh = () => {
    localStorage.removeItem(`market-${selectedSymbol}-${timeframe}`)
    setLiveMode(true)
    loadMarketData({ force: true })
  }

  const addAsset = () => {
    const symbol = newSymbol.trim().toUpperCase()
    if (!symbol) return

    if (!watchlist.some((item) => item.symbol === symbol)) {
      setWatchlist((prev) => [
        ...prev,
        {
          symbol,
          name: names[symbol] || symbol,
          price: 0,
        },
      ])
    }

    setSelectedSymbol(symbol)
    setLiveMode(true)
    setNewSymbol("")
  }

  const lastUpdatedText = lastUpdated
    ? lastUpdated.toLocaleTimeString("es-ES", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "--:--:--"

  const alerts = chartData.length
    ? [
        `${selectedSymbol}: ${technicalSignal}`,
        `${selectedSymbol}: RSI ${Number(rsi).toFixed(2)}`,
        `Última actualización: ${lastUpdatedText}`,
      ]
    : [`${selectedSymbol}: esperando datos reales OHLC`]

  const indices = [
    { name: "S&P 500 ETF", value: "$750.33", change: "+0.82%" },
    { name: "NASDAQ ETF", value: "$730.15", change: "+1.14%" },
    { name: "DAX", value: "18,421.90", change: "-0.31%" },
    { name: "FTSE MIB", value: "34,902.55", change: "+0.56%" },
  ]

  return (
    <div className="app">
      <nav className="navbar">
        <div className="logo-section">
          <div>
            <h1>📈 MarketRadarAI</h1>
            <p>Seguimiento inteligente de mercados financieros</p>
          </div>
        </div>

        <div className="nav-right">
          <div className="nav-links">
            <span>Dashboard</span>
            <span>Mercados</span>
            <span>Watchlist</span>
            <span>Alertas</span>
            <span>IA</span>
          </div>

          <div className="language-switcher">
            <button className="lang-btn active">ES</button>
            <button className="lang-btn">EN</button>
            <button className="lang-btn">IT</button>
          </div>
        </div>
      </nav>

      <div className="status-bar">
        <strong style={{ color: liveMode ? "#22c55e" : "#94a3b8" }}>
          {liveMode ? "● LIVE ON" : "● LIVE OFF"}
        </strong>
        <span style={{ marginLeft: "12px" }}>{connectionStatus}</span>
        <span style={{ marginLeft: "12px" }}>Última actualización: {lastUpdatedText}</span>
        {isLoading && <span style={{ marginLeft: "12px" }}>Actualizando...</span>}

        <button onClick={() => setLiveMode((prev) => !prev)} style={{ marginLeft: "12px" }}>
          {liveMode ? "Pausar LIVE" : "Activar LIVE"}
        </button>

        <button onClick={forceLiveRefresh} style={{ marginLeft: "8px" }}>
          Refresh
        </button>
      </div>

      <section className="hero">
        <div>
          <p className="eyebrow">Estado general del mercado</p>
          <h2>Mercado tecnológico con sesgo positivo</h2>
          <p>
            Dashboard conectado a n8n, Railway y Twelve Data. Consulta datos reales,
            calcula indicadores técnicos y mantiene controlado el consumo de API.
          </p>
        </div>

        <div className="hero-stats">
          <div>
            <span>Sentimiento</span>
            <strong className="positive">Alcista</strong>
          </div>
          <div>
            <span>Volatilidad</span>
            <strong>Moderada</strong>
          </div>
          <div>
            <span>Sector líder</span>
            <strong>Tecnología</strong>
          </div>
        </div>
      </section>

      <section className="indices-grid">
        {indices.map((item) => (
          <div className="mini-card" key={item.name}>
            <span>{item.name}</span>
            <strong>{item.value}</strong>
            <small className={item.change.startsWith("-") ? "negative" : "positive"}>
              {item.change}
            </small>
          </div>
        ))}
      </section>

      <section className="market-summary">
        <div className="summary-card">
          <span>Mercado</span>
          <strong className="positive">ABIERTO</strong>
        </div>

        <div className="summary-card">
          <span>Activo más fuerte</span>
          <strong>{topGainer.symbol}</strong>
          <p>${Number(topGainer.price).toFixed(2)}</p>
        </div>

        <div className="summary-card">
          <span>Activo más débil</span>
          <strong>{topLoser.symbol}</strong>
          <p>${Number(topLoser.price).toFixed(2)}</p>
        </div>

        <div className="summary-card">
          <span>Señal técnica</span>
          <strong>{technicalSignal}</strong>
          <p>Calculada con RSI y medias exponenciales.</p>
        </div>
      </section>

      <section className="analysis-grid">
        <div className="analysis-card">
          <span>RSI 14</span>
          <strong className={rsi > 70 ? "negative" : rsi < 30 ? "positive" : ""}>
            {Number(rsi).toFixed(2)}
          </strong>
          <p>
            {rsi > 70
              ? "Zona de sobrecompra."
              : rsi < 30
              ? "Zona de sobreventa."
              : "Momentum neutral."}
          </p>
        </div>

        <div className="analysis-card">
          <span>EMA 20</span>
          <strong>{currentEMA20}</strong>
          <p>Media exponencial rápida para señales de corto plazo.</p>
        </div>

        <div className="analysis-card">
          <span>EMA 50</span>
          <strong>{currentEMA50}</strong>
          <p>Media exponencial lenta para tendencia principal.</p>
        </div>
      </section>

      <main className="main-grid">
        <section className="panel chart-panel large">
          <div className="panel-header">
            <div>
              <h2>🕯️ Velas japonesas + Volumen - {selectedSymbol}</h2>
              <p>Histórico OHLC real recibido desde n8n y Twelve Data.</p>
            </div>
            <strong className="positive">${Number(selectedPrice).toFixed(2)}</strong>
          </div>

          <div className="symbol-buttons">
            {watchlist.map((stock) => (
              <button
                key={stock.symbol}
                className={stock.symbol === selectedSymbol ? "symbol-btn active" : "symbol-btn"}
                onClick={() => handleSymbolClick(stock.symbol)}
              >
                {stock.symbol}
              </button>
            ))}
          </div>

          <div className="timeframe-buttons">
            {["1D", "5D", "1M"].map((item) => (
              <button
                key={item}
                className={timeframe === item ? "symbol-btn active" : "symbol-btn"}
                onClick={() => handleTimeframeClick(item)}
              >
                {item}
              </button>
            ))}
          </div>

          {!chartData.length && (
            <p style={{ color: "#94a3b8", marginTop: "20px" }}>
              No hay datos OHLC cargados. Activa LIVE o usa Refresh.
            </p>
          )}

          <div
            ref={chartContainerRef}
            className="candlestick-chart"
            style={{ width: "100%", height: "500px", marginTop: "20px" }}
          />
        </section>

        <aside className="panel">
          <h2>📌 Watchlist LIVE</h2>

          <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
            <input
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addAsset()
              }}
              placeholder="AMD, NFLX, PLTR..."
              style={{
                width: "100%",
                background: "#0f172a",
                border: "1px solid #334155",
                color: "#f8fafc",
                borderRadius: "10px",
                padding: "10px",
              }}
            />
            <button onClick={addAsset}>+</button>
          </div>

          <div style={{ display: "grid", gap: "10px" }}>
            {watchlist.map((stock) => {
              const active = stock.symbol === selectedSymbol

              return (
                <button
                  key={stock.symbol}
                  onClick={() => handleSymbolClick(stock.symbol)}
                  style={{
                    textAlign: "left",
                    padding: "14px",
                    borderRadius: "14px",
                    border: active ? "1px solid #22c55e" : "1px solid #334155",
                    background: active ? "rgba(34,197,94,0.12)" : "#0f172a",
                    color: "#f8fafc",
                    cursor: "pointer",
                  }}
                >
                  <div
  style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  }}
>
  <strong>{stock.symbol}</strong>

  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
    <span className="positive">${Number(stock.price).toFixed(2)}</span>

    <button
      onClick={(e) => {
        e.stopPropagation()

        setWatchlist((prev) =>
          prev.filter((item) => item.symbol !== stock.symbol)
        )

        if (selectedSymbol === stock.symbol) {
          setSelectedSymbol("NVDA")
        }
      }}
      style={{
        background: "transparent",
        border: "none",
        color: "#ef4444",
        cursor: "pointer",
        fontSize: "14px",
        fontWeight: "bold",
        padding: "2px 6px",
      }}
    >
      ✕
    </button>
  </div>
</div>
                  <small style={{ color: "#94a3b8" }}>{stock.name}</small>
                  <div style={{ marginTop: "6px" }}>
                    <small className="positive">+0.80%</small>
                  </div>
                </button>
              )
            })}
          </div>
        </aside>

        <section className="panel alerts-panel">
          <h2>🔔 Alertas del día</h2>
          <ul className="list">
            {alerts.map((alert, index) => (
              <li key={index}>{alert}</li>
            ))}
          </ul>
        </section>

        <section className="panel ai-panel">
          <h2>🤖 Análisis automático</h2>

          <div className="analysis-card">
            <span>{selectedSymbol}</span>
            <strong>{technicalSignal}</strong>
            <p>
              RSI actual {Number(rsi).toFixed(2)}. EMA20 {currentEMA20}. EMA50{" "}
              {currentEMA50}. El análisis se calcula sobre datos OHLC reales.
            </p>
          </div>
        </section>
      </main>

      <footer>
        Herramienta de seguimiento y alertas de mercado. La información mostrada
        es informativa y no constituye asesoramiento financiero.
      </footer>
    </div>
  )
}

export default App