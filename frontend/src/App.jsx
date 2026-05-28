import { useEffect, useMemo, useRef, useState } from "react"
import { createChart, CandlestickSeries, HistogramSeries } from "lightweight-charts"

const MARKET_URL = "https://n8n-production-d92c1.up.railway.app/webhook/market-data"
//const WATCHLIST_URL = "http://localhost:5678/webhook/watchlist"

const CACHE_TTL = 5 * 60 * 1000
const WATCHLIST_CACHE_TTL = 10 * 60 * 1000

const defaultSymbols = ["NVDA", "AAPL", "MSFT", "TSLA", "META", "AMZN"]

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

const defaultWatchlist = [
  { symbol: "NVDA", name: "NVIDIA", price: 214.83 },
  { symbol: "AAPL", name: "Apple", price: 308.38 },
  { symbol: "MSFT", name: "Microsoft", price: 416.15 },
  { symbol: "TSLA", name: "Tesla", price: 433.56 },
  { symbol: "META", name: "Meta Platforms", price: 612.34 },
  { symbol: "AMZN", name: "Amazon", price: 265.31 },
]

function formatVolume(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return "0"
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(2)}K`
  return number.toFixed(0)
}

function parseChartTime(value) {
  if (!value) return Math.floor(Date.now() / 1000)

  const normalized = String(value).replace(" ", "T")
  const timestamp = Math.floor(new Date(normalized).getTime() / 1000)

  if (Number.isFinite(timestamp)) return timestamp

  return Math.floor(Date.now() / 1000)
}

function formatChartDate(value) {
  const timestamp = typeof value === "number" ? value * 1000 : new Date(value).getTime()
  const date = new Date(timestamp)

  if (!Number.isFinite(date.getTime())) return ""

  return date.toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
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
    const difference = Number(data[i].close) - Number(data[i - 1].close)
    if (difference >= 0) gains += difference
    else losses += Math.abs(difference)
  }

  const avgGain = gains / period
  const avgLoss = losses / period

  if (avgLoss === 0) return 100

  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function getTimeframeConfig(timeframe) {
  if (timeframe === "5D") return { interval: "4h", outputsize: 30 }
  if (timeframe === "1M") return { interval: "1day", outputsize: 30 }
  return { interval: "1h", outputsize: 24 }
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
    // No bloquear la app si localStorage falla.
  }
}

const translations = {
  es: {
    dashboard: "Dashboard",
    markets: "Mercados",
    watchlist: "Watchlist",
    alerts: "Alertas",
    ai: "IA",
    status: "Seguimiento inteligente de mercados financieros",
    addAsset: "+ Añadir activo",
    assetPlaceholder: "Símbolo: AMD, NFLX, PLTR...",
    chartTitle: "Velas japonesas + Volumen",
    chartSubtitle: "Histórico OHLC recibido desde n8n y Twelve Data.",
    noData: "No hay datos OHLC cargados. Activa LIVE o usa cache local.",
  },
  en: {
    dashboard: "Dashboard",
    markets: "Markets",
    watchlist: "Watchlist",
    alerts: "Alerts",
    ai: "AI",
    status: "Smart financial market tracking",
    addAsset: "+ Add asset",
    assetPlaceholder: "Symbol: AMD, NFLX, PLTR...",
    chartTitle: "Candlesticks + Volume",
    chartSubtitle: "OHLC history received from n8n and Twelve Data.",
    noData: "No OHLC data loaded. Enable LIVE or use local cache.",
  },
  it: {
    dashboard: "Dashboard",
    markets: "Mercati",
    watchlist: "Watchlist",
    alerts: "Avvisi",
    ai: "IA",
    status: "Monitoraggio intelligente dei mercati finanziari",
    addAsset: "+ Aggiungi asset",
    assetPlaceholder: "Simbolo: AMD, NFLX, PLTR...",
    chartTitle: "Candele giapponesi + Volume",
    chartSubtitle: "Storico OHLC ricevuto da n8n e Twelve Data.",
    noData: "Nessun dato OHLC caricato. Attiva LIVE o usa la cache locale.",
  },
}

function App() {
  const [selectedSymbol, setSelectedSymbol] = useState("NVDA")
  const [chartData, setChartData] = useState([])
  const [watchlist, setWatchlist] = useState(defaultWatchlist)
  const [connectionStatus, setConnectionStatus] = useState("Modo seguro: sin consumo API")
  const [language, setLanguage] = useState("es")
  const [timeframe, setTimeframe] = useState("1D")
  const [newSymbol, setNewSymbol] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [liveMode, setLiveMode] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const t = translations[language]
  const chartContainerRef = useRef(null)

  const safeWatchlist = watchlist.length > 0 ? watchlist : defaultWatchlist
  const symbols = safeWatchlist.map((item) => item.symbol)
  const selectedAsset = safeWatchlist.find((item) => item.symbol === selectedSymbol)

  const selectedPrice =
    chartData[chartData.length - 1]?.close || selectedAsset?.price || 0

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

  const topGainer = safeWatchlist.reduce((prev, current) =>
    Number(current.price) > Number(prev.price) ? current : prev
  )

  const topLoser = safeWatchlist.reduce((prev, current) =>
    Number(current.price) < Number(prev.price) ? current : prev
  )

  const marketOpen = true

  const alerts = useMemo(() => {
    if (!chartData.length) return [`${selectedSymbol}: esperando datos reales OHLC`]

    const last = chartData[chartData.length - 1]
    const first = chartData[0]
    const change = ((last.close - first.open) / first.open) * 100
    const avgVolume =
      chartData.reduce((sum, item) => sum + Number(item.volume || 0), 0) /
      chartData.length

    const result = []

    result.push(
      `${selectedSymbol}: ${change >= 0 ? "sesgo alcista" : "sesgo bajista"} (${change.toFixed(2)}%)`
    )

    if (last.volume > avgVolume * 1.3) {
      result.push(`${selectedSymbol}: volumen superior al promedio`)
    }

    if (rsi > 70) result.push(`${selectedSymbol}: RSI en zona de sobrecompra`)
    if (rsi < 30) result.push(`${selectedSymbol}: RSI en zona de sobreventa`)

    result.push(
      last.close > last.open
        ? `${selectedSymbol}: última vela positiva`
        : `${selectedSymbol}: última vela negativa`
    )

    result.push(`Timeframe activo: ${timeframe}`)

    return result
  }, [chartData, selectedSymbol, timeframe, rsi])

  const scrollToSection = (selector) => {
    document.querySelector(selector)?.scrollIntoView({ behavior: "smooth" })
  }

  const addAsset = () => {
    const symbol = newSymbol.trim().toUpperCase()

    if (!symbol) return

    if (safeWatchlist.some((item) => item.symbol === symbol)) {
      setSelectedSymbol(symbol)
      setNewSymbol("")
      return
    }

    const newAsset = {
      symbol,
      name: names[symbol] || symbol,
      price: 0,
    }

    setWatchlist((prev) => [...prev, newAsset])
    setSelectedSymbol(symbol)
    setNewSymbol("")
  }

  const forceLiveRefresh = () => {
    const cacheKey = `market-${selectedSymbol}-${timeframe}`
    localStorage.removeItem(cacheKey)
    setLiveMode(true)
    setRefreshKey((prev) => prev + 1)
  }

  useEffect(() => {
    const controller = new AbortController()
    const cacheKey = `market-${selectedSymbol}-${timeframe}`

    const loadMarketData = async () => {
      const cachedData = readCache(cacheKey, CACHE_TTL)

      if (cachedData) {
        setChartData(cachedData)
        setConnectionStatus(`Cache local - ${selectedSymbol} / ${timeframe}`)
        return
      }

      if (!liveMode) {
        setConnectionStatus("Modo seguro: no se consulta API")
        setChartData([])
        return
      }

      try {
        setIsLoading(true)
        setConnectionStatus(`LIVE: cargando ${selectedSymbol}...`)

        const { interval, outputsize } = getTimeframeConfig(timeframe)

        const response = await fetch(
          `${MARKET_URL}?symbol=${selectedSymbol}&interval=${interval}&outputsize=${outputsize}`,
          { signal: controller.signal }
        )

        const text = await response.text()

        if (!text) {
          setConnectionStatus("Respuesta vacía desde market-data")
          setChartData([])
          return
        }

        const data = JSON.parse(text)

        if (data.chartData && Array.isArray(data.chartData)) {
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
          setConnectionStatus(`LIVE conectado - ${selectedSymbol} / ${timeframe}`)
        } else {
          setChartData([])
          setConnectionStatus("Sin chartData válido desde n8n")
        }
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error("Error cargando gráfico:", error)
          setConnectionStatus("Error cargando datos desde n8n")
          setChartData([])
        }
      } finally {
        setIsLoading(false)
      }
    }

    loadMarketData()

    return () => {
      controller.abort()
    }
  }, [selectedSymbol, timeframe, liveMode, refreshKey])

  useEffect(() => {
    const controller = new AbortController()
    const cacheKey = "watchlist-cache"

    const loadWatchlist = async () => {
      const cachedWatchlist = readCache(cacheKey, WATCHLIST_CACHE_TTL)

      if (cachedWatchlist) {
        setWatchlist(cachedWatchlist)
        return
      }

      if (!liveMode) return

      try {
        const response = await fetch(WATCHLIST_URL, { signal: controller.signal })
        const text = await response.text()

        if (!text) return

        const data = JSON.parse(text)

        if (!data.watchlist || !Array.isArray(data.watchlist)) return

        const formattedWatchlist = data.watchlist
          .filter((item) => item.symbol && item.price)
          .map((item) => ({
            symbol: item.symbol,
            name: names[item.symbol] || item.symbol,
            price: Number(item.price),
          }))

        if (formattedWatchlist.length > 0) {
          setWatchlist((prev) => {
            const manualAssets = prev.filter(
              (item) =>
                !defaultSymbols.includes(item.symbol) &&
                !formattedWatchlist.some((apiItem) => apiItem.symbol === item.symbol)
            )

            const merged = [...formattedWatchlist, ...manualAssets]
            writeCache(cacheKey, merged)
            return merged
          })
        }
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error("Error cargando watchlist:", error)
        }
      }
    }

    loadWatchlist()

    return () => {
      controller.abort()
    }
  }, [liveMode])

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

    const candleData = chartData
      .map((item) => ({
        time: parseChartTime(item.time),
        open: Number(Number(item.open).toFixed(2)),
        high: Number(Number(item.high).toFixed(2)),
        low: Number(Number(item.low).toFixed(2)),
        close: Number(Number(item.close).toFixed(2)),
      }))
      .filter(
        (item) =>
          item.time &&
          !isNaN(item.open) &&
          !isNaN(item.high) &&
          !isNaN(item.low) &&
          !isNaN(item.close)
      )

    const volumeData = chartData
      .map((item) => ({
        time: parseChartTime(item.time),
        value: Number(item.volume || 0),
        color:
          Number(item.close) >= Number(item.open)
            ? "rgba(34, 197, 94, 0.45)"
            : "rgba(239, 68, 68, 0.45)",
      }))
      .filter((item) => item.time && !isNaN(item.value))

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
            <p>{t.status}</p>
          </div>
        </div>

        <div className="nav-right">
          <div className="nav-links">
            <span onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
              {t.dashboard}
            </span>
            <span onClick={() => scrollToSection(".chart-panel")}>{t.markets}</span>
            <span onClick={() => scrollToSection(".large")}>{t.watchlist}</span>
            <span onClick={() => scrollToSection(".alerts-panel")}>{t.alerts}</span>
            <span onClick={() => scrollToSection(".ai-panel")}>{t.ai}</span>
          </div>

          <div className="language-switcher">
            <button
              className={language === "es" ? "lang-btn active" : "lang-btn"}
              onClick={() => setLanguage("es")}
            >
              ES
            </button>
            <button
              className={language === "en" ? "lang-btn active" : "lang-btn"}
              onClick={() => setLanguage("en")}
            >
              EN
            </button>
            <button
              className={language === "it" ? "lang-btn active" : "lang-btn"}
              onClick={() => setLanguage("it")}
            >
              IT
            </button>
          </div>
        </div>
      </nav>

      <div className="status-bar">
        {connectionStatus}
        {isLoading ? " · Actualizando..." : ""}
        <button onClick={() => setLiveMode((prev) => !prev)} style={{ marginLeft: "12px" }}>
          {liveMode ? "LIVE ON" : "LIVE OFF"}
        </button>
        <button onClick={forceLiveRefresh} style={{ marginLeft: "8px" }}>
          Actualizar live
        </button>
      </div>

      <section className="hero">
        <div>
          <p className="eyebrow">Estado general del mercado</p>
          <h2>Mercado tecnológico con sesgo positivo</h2>
          <p>
            Dashboard financiero conectado a n8n y Twelve Data. En modo seguro
            no consume API. En modo LIVE consulta datos reales bajo control.
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
          <strong className={marketOpen ? "positive" : "negative"}>
            {marketOpen ? "ABIERTO" : "CERRADO"}
          </strong>
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

      <section className="panel chart-panel">
        <div className="panel-header">
          <div>
            <h2>🕯️ {t.chartTitle} - {selectedSymbol}</h2>
            <p>{t.chartSubtitle}</p>
          </div>
          <strong className="positive">${Number(selectedPrice).toFixed(2)}</strong>
        </div>

        <div className="symbol-buttons">
          {symbols.map((symbol) => (
            <button
              key={symbol}
              className={symbol === selectedSymbol ? "symbol-btn active" : "symbol-btn"}
              onClick={() => setSelectedSymbol(symbol)}
            >
              {symbol}
            </button>
          ))}
        </div>

        <div className="timeframe-buttons">
          {["1D", "5D", "1M"].map((item) => (
            <button
              key={item}
              className={timeframe === item ? "symbol-btn active" : "symbol-btn"}
              onClick={() => setTimeframe(item)}
            >
              {item}
            </button>
          ))}
        </div>

        {!chartData.length && (
          <p style={{ color: "#94a3b8", marginTop: "20px" }}>{t.noData}</p>
        )}

        <div
          ref={chartContainerRef}
          className="candlestick-chart"
          style={{
            width: "100%",
            height: "500px",
            marginTop: "20px",
          }}
        />
      </section>

      <main className="main-grid">
        <section className="panel large">
          <div className="panel-header">
            <h2>⭐ Watchlist</h2>
          </div>

          <div style={{ display: "flex", gap: "10px", marginBottom: "18px" }}>
            <input
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addAsset()
              }}
              placeholder={t.assetPlaceholder}
              style={{
                flex: 1,
                background: "#0f172a",
                border: "1px solid #334155",
                color: "#f8fafc",
                borderRadius: "12px",
                padding: "10px 14px",
              }}
            />
            <button onClick={addAsset}>{t.addAsset}</button>
          </div>

          <div className="table">
            <div className="table-row table-head">
              <span>Activo</span>
              <span>Precio</span>
              <span>Cambio</span>
              <span>RSI</span>
              <span>Tendencia</span>
            </div>

            {safeWatchlist.map((stock) => (
              <div className="table-row" key={stock.symbol}>
                <span>
                  <strong>{stock.symbol}</strong>
                  <small>{stock.name}</small>
                </span>
                <span>${Number(stock.price).toFixed(2)}</span>
                <span className="positive">+0.80%</span>
                <span>{stock.symbol === selectedSymbol ? Number(rsi).toFixed(0) : "--"}</span>
                <span className={technicalSignal === "Tendencia bajista" ? "negative" : "positive"}>
                  {stock.symbol === selectedSymbol ? technicalSignal : "En seguimiento"}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel alerts-panel">
          <h2>🔔 Alertas del día</h2>
          <ul className="list">
            {alerts.map((alert, index) => (
              <li key={index}>{alert}</li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>📰 Noticias relevantes</h2>
          <ul className="list">
            <li>NVIDIA fortalece expectativas por demanda de chips IA</li>
            <li>Tesla cae tras dudas sobre entregas trimestrales</li>
            <li>Apple mantiene presión compradora en el sector tecnológico</li>
          </ul>
        </section>

        <section className="panel ai-panel">
          <h2>🤖 Análisis automático</h2>
          <div className="analysis-grid">
            <div className="analysis-card">
              <span>{selectedSymbol}</span>
              <strong>${Number(selectedPrice).toFixed(2)}</strong>
              <p>
                El gráfico muestra velas OHLC reales cuando LIVE está activo.
                En modo seguro evita consumo innecesario de API.
              </p>
            </div>
            <div className="analysis-card">
              <span>Watchlist</span>
              <strong>{safeWatchlist.length} activos</strong>
              <p>La watchlist permite añadir activos manualmente para esta sesión.</p>
            </div>
            <div className="analysis-card">
              <span>Timeframe</span>
              <strong>{timeframe}</strong>
              <p>El selector cambia interval y outputsize enviados al webhook de n8n.</p>
            </div>
          </div>
        </section>
      </main>

      <footer>
        Herramienta de seguimiento y alertas de mercado. La información mostrada
        es de carácter informativo y no constituye asesoramiento financiero.
      </footer>
    </div>
  )
}

export default App