import { type NextRequest, NextResponse } from "next/server"
import { Buffer } from "buffer"

interface PriceData {
  date: string
  close: number
}

// Fetch stock data from Yahoo Finance API
async function fetchStockData(ticker: string, startDate: string, endDate: string): Promise<PriceData[]> {
  const period1 = Math.floor(new Date(startDate).getTime() / 1000)
  const period2 = Math.floor(new Date(endDate).getTime() / 1000)

  // Use the v8 API endpoint instead of download endpoint
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d`

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[v0] Yahoo Finance error:", errorText)
      throw new Error(`Failed to fetch data for ${ticker}`)
    }

    const json = await response.json()

    if (!json?.chart?.result?.[0]) {
      throw new Error(`No data available for ${ticker}`)
    }

    const result = json.chart.result[0]
    const timestamps = result.timestamp
    const closes = result.indicators.quote[0].close

    if (!timestamps || !closes) {
      throw new Error(`Invalid data format for ${ticker}`)
    }

    const data: PriceData[] = []
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] !== null && closes[i] !== undefined) {
        const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0]
        data.push({
          date,
          close: closes[i],
        })
      }
    }

    console.log(`[v0] Fetched ${data.length} data points for ${ticker}`)
    return data
  } catch (error) {
    console.error("[v0] Fetch error:", error)
    throw new Error(`Failed to fetch data for ${ticker}: ${error instanceof Error ? error.message : "Unknown error"}`)
  }
}

// Calculate returns
function calculateReturns(prices: number[]): number[] {
  const returns: number[] = [Number.NaN]
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1])
  }
  return returns
}

// Calculate rolling volatility
function rollingVolatility(returns: number[], window: number): number[] {
  const vol: number[] = []

  for (let i = 0; i < returns.length; i++) {
    if (i < window - 1) {
      vol.push(Number.NaN)
      continue
    }

    const slice = returns.slice(i - window + 1, i + 1).filter((v) => !isNaN(v))
    if (slice.length < window * 0.8) {
      vol.push(Number.NaN)
      continue
    }

    const mean = slice.reduce((sum, v) => sum + v, 0) / slice.length
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / slice.length
    const std = Math.sqrt(variance)
    vol.push(std * Math.sqrt(252)) // Annualized
  }

  return vol
}

// Hurst exponent using DFA method
function hurstDFA(series: number[]): number {
  const n = series.length
  if (n < 20) return Number.NaN

  const mean = series.reduce((sum, v) => sum + v, 0) / n
  const centered = series.map((v) => v - mean)
  const cumsum = centered.reduce((acc, v) => [...acc, (acc[acc.length - 1] || 0) + v], [] as number[])

  const scales: number[] = []
  const fluctuations: number[] = []

  for (let scale = 4; scale < Math.min(Math.floor(n / 4), 30); scale++) {
    const numSeg = Math.floor(n / scale)
    if (numSeg < 2) continue

    const localF: number[] = []
    for (let i = 0; i < numSeg; i++) {
      const seg = cumsum.slice(i * scale, (i + 1) * scale)
      const x = Array.from({ length: scale }, (_, j) => j)

      // Linear fit
      const xMean = (scale - 1) / 2
      const yMean = seg.reduce((sum, v) => sum + v, 0) / scale
      let num = 0,
        den = 0
      for (let j = 0; j < scale; j++) {
        num += (x[j] - xMean) * (seg[j] - yMean)
        den += Math.pow(x[j] - xMean, 2)
      }
      const slope = num / den
      const intercept = yMean - slope * xMean

      // Calculate fluctuation
      const trend = x.map((xi) => slope * xi + intercept)
      const detrended = seg.map((v, j) => v - trend[j])
      const f = Math.sqrt(detrended.reduce((sum, v) => sum + v * v, 0) / scale)
      localF.push(f)
    }

    if (localF.length > 0) {
      scales.push(scale)
      fluctuations.push(localF.reduce((sum, v) => sum + v, 0) / localF.length)
    }
  }

  if (scales.length < 3) return Number.NaN

  // Log-log linear fit
  const logScales = scales.map((s) => Math.log(s))
  const logFluct = fluctuations.map((f) => Math.log(f))
  const xMean = logScales.reduce((sum, v) => sum + v, 0) / logScales.length
  const yMean = logFluct.reduce((sum, v) => sum + v, 0) / logFluct.length

  let num = 0,
    den = 0
  for (let i = 0; i < logScales.length; i++) {
    num += (logScales[i] - xMean) * (logFluct[i] - yMean)
    den += Math.pow(logScales[i] - xMean, 2)
  }

  const hurst = num / den
  return Math.max(0.01, Math.min(0.99, hurst))
}

// Rolling Hurst
function rollingHurst(returns: number[], window: number): number[] {
  const hurst: number[] = []

  for (let i = 0; i < returns.length; i++) {
    if (i < window) {
      hurst.push(Number.NaN)
      continue
    }

    const slice = returns.slice(i - window, i).filter((v) => !isNaN(v))
    if (slice.length < window * 0.8) {
      hurst.push(Number.NaN)
      continue
    }

    hurst.push(hurstDFA(slice))
  }

  return hurst
}

// Classify regime
function classifyRegimes(volatility: number[], hurst: number[]): string[] {
  const validVol = volatility.filter((v) => !isNaN(v))
  const vLow = quantile(validVol, 0.33)
  const vHigh = quantile(validVol, 0.66)
  const vMid = quantile(validVol, 0.5)

  // Absolute thresholds (annualized volatility)
  const ABS_LOW_VOL = 0.15   // 15% - below this is objectively low
  const ABS_MID_VOL = 0.30   // 30% - above this is never "Low Vol"
  const ABS_HIGH_VOL = 0.50  // 50% - above this is always "High Vol"

  const regimes: string[] = []

  for (let i = 0; i < volatility.length; i++) {
    const v = volatility[i]
    const h = hurst[i]

    if (isNaN(v) || isNaN(h)) {
      regimes.push("Unknown")
    } else if (v > ABS_HIGH_VOL) {
      // Absolute override: very high volatility is always High Vol
      regimes.push("High Vol")
    } else if (v > ABS_HIGH_VOL * 0.8 && h > 0.55) {
      // High volatility + trending = Trending
      regimes.push("Trending")
    } else if (v < ABS_LOW_VOL && h < 0.45) {
      regimes.push("Calm")
    } else if (v < vLow && v < ABS_MID_VOL && h < 0.45) {
      // Only "Low Vol" if below absolute threshold too
      regimes.push("Calm")
    } else if (v > vHigh && h > 0.55) {
      regimes.push("Trending")
    } else if (v > vHigh || (h > 0.55 && v > vMid)) {
      regimes.push("High Vol")
    } else if (v < vLow && v < ABS_MID_VOL) {
      // Only "Low Vol" if below absolute mid threshold
      regimes.push("Low Vol")
    } else {
      regimes.push("Transition")
    }
  }

  return regimes
}

function quantile(arr: number[], q: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base

  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  } else {
    return sorted[base]
  }
}

// Generate SVG plot for regimes
function generateRegimePlot(
  dates: string[],
  prices: number[],
  volatility: number[],
  hurst: number[],
  regimes: string[],
): string {
  const colors: Record<string, string> = {
    Calm: "#2ecc71",
    "Low Vol": "#27ae60",
    Trending: "#e74c3c",
    "High Vol": "#c0392b",
    Transition: "#f39c12",
    Unknown: "#95a5a6",
  }

  const width = 1200
  const height = 800
  const padding = 50
  const plotHeight = (height - 5 * padding) / 4

  // Filter valid indices
  const validIndices = regimes.map((r, i) => (r !== "Unknown" ? i : -1)).filter((i) => i >= 0)
  if (validIndices.length === 0) return ""

  const startIdx = validIndices[0]
  const endIdx = validIndices[validIndices.length - 1]

  const xScale = (width - 2 * padding) / (endIdx - startIdx)

  // Price scale
  const validPrices = prices.slice(startIdx, endIdx + 1)
  const priceMin = Math.min(...validPrices)
  const priceMax = Math.max(...validPrices)
  const priceScale = plotHeight / (priceMax - priceMin)

  // Vol scale
  const validVol = volatility.slice(startIdx, endIdx + 1).filter((v) => !isNaN(v))
  const volMin = Math.min(...validVol)
  const volMax = Math.max(...validVol)
  const volScale = plotHeight / (volMax - volMin)

  // Dark theme colors
  const bgColor = "#1a1a1a"
  const textColor = "#e5e5e5"
  const gridColor = "#333333"

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
  svg += `<rect width="${width}" height="${height}" fill="${bgColor}"/>`

  // Plot 1: Price with regime backgrounds (no main title - UI handles that)
  const y1Start = padding
  svg += `<rect x="${padding}" y="${y1Start}" width="${width - 2 * padding}" height="${plotHeight}" fill="none" stroke="${gridColor}"/>`

  // Regime backgrounds
  for (let i = startIdx; i < endIdx; i++) {
    const x1 = padding + (i - startIdx) * xScale
    const x2 = padding + (i + 1 - startIdx) * xScale
    const color = colors[regimes[i]] || "#ccc"
    svg += `<rect x="${x1}" y="${y1Start}" width="${x2 - x1}" height="${plotHeight}" fill="${color}" opacity="0.3"/>`
  }

  // Price line
  let pricePath = `M${padding},${y1Start + plotHeight - (prices[startIdx] - priceMin) * priceScale}`
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const x = padding + (i - startIdx) * xScale
    const y = y1Start + plotHeight - (prices[i] - priceMin) * priceScale
    pricePath += ` L${x},${y}`
  }
  svg += `<path d="${pricePath}" fill="none" stroke="#60a5fa" stroke-width="1.5"/>`
  svg += `<text x="10" y="${y1Start + plotHeight / 2}" font-size="12" fill="${textColor}">Price</text>`

  // Plot 2: Volatility
  const y2Start = y1Start + plotHeight + padding
  svg += `<rect x="${padding}" y="${y2Start}" width="${width - 2 * padding}" height="${plotHeight}" fill="none" stroke="${gridColor}"/>`

  let volPath = ""
  for (let i = startIdx; i <= endIdx; i++) {
    if (!isNaN(volatility[i])) {
      const x = padding + (i - startIdx) * xScale
      const y = y2Start + plotHeight - (volatility[i] - volMin) * volScale
      if (volPath === "") {
        volPath = `M${x},${y}`
      } else {
        volPath += ` L${x},${y}`
      }
    }
  }
  if (volPath) {
    svg += `<path d="${volPath} L${padding + (endIdx - startIdx) * xScale},${y2Start + plotHeight} L${padding},${y2Start + plotHeight} Z" fill="#a855f7" opacity="0.5"/>`
  }
  svg += `<text x="10" y="${y2Start + plotHeight / 2}" font-size="12" fill="${textColor}">Vol</text>`

  // Plot 3: Hurst
  const y3Start = y2Start + plotHeight + padding
  svg += `<rect x="${padding}" y="${y3Start}" width="${width - 2 * padding}" height="${plotHeight}" fill="none" stroke="${gridColor}"/>`
  svg += `<line x1="${padding}" y1="${y3Start + plotHeight / 2}" x2="${width - padding}" y2="${y3Start + plotHeight / 2}" stroke="${textColor}" stroke-width="1"/>`

  let hurstPath = ""
  for (let i = startIdx; i <= endIdx; i++) {
    if (!isNaN(hurst[i])) {
      const x = padding + (i - startIdx) * xScale
      const y = y3Start + plotHeight - hurst[i] * plotHeight
      if (hurstPath === "") {
        hurstPath = `M${x},${y}`
      } else {
        hurstPath += ` L${x},${y}`
      }
    }
  }
  if (hurstPath) {
    svg += `<path d="${hurstPath}" fill="none" stroke="#fb923c" stroke-width="2"/>`
  }
  svg += `<text x="10" y="${y3Start + plotHeight / 2}" font-size="12" fill="${textColor}">Hurst</text>`

  // Plot 4: Regime bars
  const y4Start = y3Start + plotHeight + padding
  svg += `<rect x="${padding}" y="${y4Start}" width="${width - 2 * padding}" height="${30}" fill="none" stroke="${gridColor}"/>`

  for (let i = startIdx; i < endIdx; i++) {
    const x1 = padding + (i - startIdx) * xScale
    const x2 = padding + (i + 1 - startIdx) * xScale
    const color = colors[regimes[i]] || "#ccc"
    svg += `<rect x="${x1}" y="${y4Start}" width="${x2 - x1}" height="30" fill="${color}" opacity="0.8"/>`
  }

  // Legend
  const legendY = y4Start + 50
  const legendItems = Object.entries(colors).filter(([k]) => k !== "Unknown")
  let legendX = padding
  for (const [regime, color] of legendItems) {
    svg += `<rect x="${legendX}" y="${legendY}" width="15" height="15" fill="${color}"/>`
    svg += `<text x="${legendX + 20}" y="${legendY + 12}" font-size="11" fill="${textColor}">${regime}</text>`
    legendX += 100
  }

  svg += `</svg>` // Fixed the undeclared variable issue

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
}

// Generate stats plot
function generateStatsPlot(returns: number[], volatility: number[], regimes: string[]): string {
  const colors: Record<string, string> = {
    Calm: "#2ecc71",
    "Low Vol": "#27ae60",
    Trending: "#e74c3c",
    "High Vol": "#c0392b",
    Transition: "#f39c12",
  }

  const uniqueRegimes = Array.from(new Set(regimes)).filter((r) => r !== "Unknown")

  // Calculate stats
  const stats: Record<string, { vol: number; ret: number; sharpe: number; duration: number }> = {}

  for (const regime of uniqueRegimes) {
    const indices = regimes.map((r, i) => (r === regime ? i : -1)).filter((i) => i >= 0)
    const regimeReturns = indices.map((i) => returns[i]).filter((r) => !isNaN(r))
    const regimeVol = indices.map((i) => volatility[i]).filter((v) => !isNaN(v))

    const avgVol = regimeVol.reduce((sum, v) => sum + v, 0) / regimeVol.length
    const avgRet = (regimeReturns.reduce((sum, v) => sum + v, 0) / regimeReturns.length) * 252
    const retStd =
      Math.sqrt(
        regimeReturns.reduce(
          (sum, v) => sum + Math.pow(v - regimeReturns.reduce((s, x) => s + x, 0) / regimeReturns.length, 2),
          0,
        ) / regimeReturns.length,
      ) * Math.sqrt(252)
    const sharpe = retStd > 0 ? avgRet / retStd : 0

    // Duration
    const durations: number[] = []
    let currDur = 0
    for (let i = 0; i < regimes.length; i++) {
      if (regimes[i] === regime) {
        currDur++
      } else if (currDur > 0) {
        durations.push(currDur)
        currDur = 0
      }
    }
    const avgDuration = durations.length > 0 ? durations.reduce((sum, d) => sum + d, 0) / durations.length : 0

    stats[regime] = { vol: avgVol, ret: avgRet, sharpe, duration: avgDuration }
  }

  const width = 1000
  const height = 650
  const padding = 80
  const bottomPadding = 60
  const plotWidth = (width - 3 * padding) / 2
  const plotHeight = (height - 2 * padding - bottomPadding) / 2

  // Dark theme colors
  const bgColor = "#1a1a1a"
  const textColor = "#e5e5e5"
  const gridColor = "#333333"

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
  svg += `<rect width="${width}" height="${height}" fill="${bgColor}"/>`

  // Plot 1: Volatility (no main title - UI handles that)
  const maxVol = Math.max(...Object.values(stats).map((s) => s.vol))
  const barWidth = plotWidth / uniqueRegimes.length - 10
  let x = padding
  const y1Start = padding

  svg += `<text x="${x + plotWidth / 2}" y="${y1Start - 10}" text-anchor="middle" font-size="14" fill="${textColor}">Annualized Volatility</text>`
  uniqueRegimes.forEach((regime, i) => {
    const barHeight = (stats[regime].vol / maxVol) * plotHeight
    const barX = x + i * (plotWidth / uniqueRegimes.length) + 5
    svg += `<rect x="${barX}" y="${y1Start + plotHeight - barHeight}" width="${barWidth}" height="${barHeight}" fill="${colors[regime]}"/>`
    svg += `<text x="${barX + barWidth / 2}" y="${y1Start + plotHeight + 20}" text-anchor="end" font-size="10" fill="${textColor}" transform="rotate(-45 ${barX + barWidth / 2} ${y1Start + plotHeight + 20})">${regime}</text>`
    svg += `<text x="${barX + barWidth / 2}" y="${y1Start + plotHeight - barHeight - 5}" text-anchor="middle" font-size="9" fill="${textColor}">${(stats[regime].vol * 100).toFixed(1)}%</text>`
  })

  // Plot 2: Returns
  const maxRet = Math.max(...Object.values(stats).map((s) => Math.abs(s.ret)))
  x = padding + plotWidth + padding

  svg += `<text x="${x + plotWidth / 2}" y="${y1Start - 10}" text-anchor="middle" font-size="14" fill="${textColor}">Annualized Return</text>`
  svg += `<line x1="${x}" y1="${y1Start + plotHeight / 2}" x2="${x + plotWidth}" y2="${y1Start + plotHeight / 2}" stroke="${gridColor}" stroke-width="1"/>`
  uniqueRegimes.forEach((regime, i) => {
    const barHeight = Math.abs(stats[regime].ret / maxRet) * (plotHeight / 2)
    const barX = x + i * (plotWidth / uniqueRegimes.length) + 5
    const barY = stats[regime].ret >= 0 ? y1Start + plotHeight / 2 - barHeight : y1Start + plotHeight / 2
    svg += `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" fill="${colors[regime]}"/>`
    svg += `<text x="${barX + barWidth / 2}" y="${y1Start + plotHeight + 20}" text-anchor="end" font-size="10" fill="${textColor}" transform="rotate(-45 ${barX + barWidth / 2} ${y1Start + plotHeight + 20})">${regime}</text>`
    svg += `<text x="${barX + barWidth / 2}" y="${barY - 5}" text-anchor="middle" font-size="9" fill="${textColor}">${(stats[regime].ret * 100).toFixed(1)}%</text>`
  })

  // Plot 3: Sharpe
  const maxSharpe = Math.max(...Object.values(stats).map((s) => Math.abs(s.sharpe)))
  x = padding
  const y2Start = y1Start + plotHeight + padding + 50

  svg += `<text x="${x + plotWidth / 2}" y="${y2Start - 10}" text-anchor="middle" font-size="14" fill="${textColor}">Sharpe Ratio</text>`
  svg += `<line x1="${x}" y1="${y2Start + plotHeight / 2}" x2="${x + plotWidth}" y2="${y2Start + plotHeight / 2}" stroke="${gridColor}" stroke-width="1"/>`
  uniqueRegimes.forEach((regime, i) => {
    const barHeight = Math.abs(stats[regime].sharpe / maxSharpe) * (plotHeight / 2)
    const barX = x + i * (plotWidth / uniqueRegimes.length) + 5
    const barY = stats[regime].sharpe >= 0 ? y2Start + plotHeight / 2 - barHeight : y2Start + plotHeight / 2
    svg += `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" fill="${colors[regime]}"/>`
    svg += `<text x="${barX + barWidth / 2}" y="${y2Start + plotHeight + 20}" text-anchor="end" font-size="10" fill="${textColor}" transform="rotate(-45 ${barX + barWidth / 2} ${y2Start + plotHeight + 20})">${regime}</text>`
    svg += `<text x="${barX + barWidth / 2}" y="${barY - 5}" text-anchor="middle" font-size="9" fill="${textColor}">${stats[regime].sharpe.toFixed(2)}</text>`
  })

  // Plot 4: Duration
  const maxDur = Math.max(...Object.values(stats).map((s) => s.duration))
  x = padding + plotWidth + padding

  svg += `<text x="${x + plotWidth / 2}" y="${y2Start - 10}" text-anchor="middle" font-size="14" fill="${textColor}">Avg Duration (Days)</text>`
  uniqueRegimes.forEach((regime, i) => {
    const barHeight = (stats[regime].duration / maxDur) * plotHeight
    const barX = x + i * (plotWidth / uniqueRegimes.length) + 5
    svg += `<rect x="${barX}" y="${y2Start + plotHeight - barHeight}" width="${barWidth}" height="${barHeight}" fill="${colors[regime]}"/>`
    svg += `<text x="${barX + barWidth / 2}" y="${y2Start + plotHeight + 20}" text-anchor="end" font-size="10" fill="${textColor}" transform="rotate(-45 ${barX + barWidth / 2} ${y2Start + plotHeight + 20})">${regime}</text>`
    svg += `<text x="${barX + barWidth / 2}" y="${y2Start + plotHeight - barHeight - 5}" text-anchor="middle" font-size="9" fill="${textColor}">${stats[regime].duration.toFixed(1)}</text>`
  })

  svg += `</svg>`

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
}

function getRecommendation(regime: string): { strategy: string; risk: string; action: string } {
  const recs: Record<string, { strategy: string; risk: string; action: string }> = {
    Calm: { strategy: "Mean Reversion", risk: "Low", action: "Sell options, pairs trade" },
    "Low Vol": { strategy: "Range Trading", risk: "Low", action: "Sell options, iron condors" },
    Trending: { strategy: "Trend Following", risk: "High", action: "Momentum, breakouts, buy options" },
    "High Vol": { strategy: "Hedging", risk: "High", action: "Buy options, VIX, reduce exposure" },
    Transition: { strategy: "Caution", risk: "Medium", action: "Reduce exposure, wait for clarity" },
  }

  return recs[regime] || { strategy: "Unknown", risk: "Unknown", action: "Insufficient data" }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { ticker, startDate, endDate, volWindow, hurstWindow } = body

    console.log("[v0] Analysis request:", { ticker, startDate, endDate, volWindow, hurstWindow })

    // Fetch data
    const data = await fetchStockData(ticker, startDate, endDate)
    if (data.length < Math.max(volWindow, hurstWindow) + 10) {
      return NextResponse.json({ error: "Insufficient data for analysis" }, { status: 400 })
    }

    const dates = data.map((d) => d.date)
    const prices = data.map((d) => d.close)

    // Calculate indicators
    const returns = calculateReturns(prices)
    const volatility = rollingVolatility(returns, volWindow)
    const hurst = rollingHurst(returns, hurstWindow)
    const regimes = classifyRegimes(volatility, hurst)

    // Find last valid regime
    let lastIdx = regimes.length - 1
    while (lastIdx >= 0 && regimes[lastIdx] === "Unknown") {
      lastIdx--
    }

    if (lastIdx < 0) {
      return NextResponse.json({ error: "Could not determine current regime" }, { status: 400 })
    }

    const currentRegime = regimes[lastIdx]
    const currentVol = volatility[lastIdx]
    const currentHurst = hurst[lastIdx]
    const currentDate = dates[lastIdx]

    const { strategy, risk, action } = getRecommendation(currentRegime)

    // Generate plots
    const regimePlotUrl = generateRegimePlot(dates, prices, volatility, hurst, regimes)
    const statsPlotUrl = generateStatsPlot(returns, volatility, regimes)

    const response = {
      regime: currentRegime,
      strategy,
      risk,
      description: action,
      volatility: `${(currentVol * 100).toFixed(2)}%`,
      hurst: currentHurst.toFixed(3),
      hurstType: currentHurst > 0.5 ? "Persistent" : "Mean-Reverting",
      date: currentDate,
      regimePlotUrl,
      statsPlotUrl,
    }

    console.log("[v0] Analysis complete:", { regime: currentRegime, date: currentDate })

    return NextResponse.json(response)
  } catch (error) {
    console.error("[v0] API error:", error)
    const errorMessage = error instanceof Error ? error.message : "Internal server error"
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
