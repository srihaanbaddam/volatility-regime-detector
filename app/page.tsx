"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, TrendingUp, Activity } from "lucide-react"

interface AnalysisResult {
  regime: string
  strategy: string
  risk: string
  description: string
  volatility: string
  hurst: string
  hurstType: string
  date: string
  regimePlotUrl: string
  statsPlotUrl: string
  volPercentile: number
  daysSinceChange: number
  confidence: string
}

export default function VolatilityDetectorPage() {
  const [ticker, setTicker] = useState("SPY")
  const [startDate, setStartDate] = useState("2021-01-01")
  const [endDate, setEndDate] = useState("2026-01-01")
  const [volWindow, setVolWindow] = useState("21")
  const [hurstWindow, setHurstWindow] = useState("63")
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleAnalysis = async () => {
    setIsLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ticker,
          startDate,
          endDate,
          volWindow: Number.parseInt(volWindow),
          hurstWindow: Number.parseInt(hurstWindow),
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `Analysis failed: ${response.statusText}`)
      }

      const data = await response.json()
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred during analysis")
      console.error("[v0] Analysis error:", err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold mb-3 text-balance">Volatility Regime Detector</h1>
          <p className="text-muted-foreground text-lg">
            Analyze market regimes using volatility and Hurst exponent metrics
          </p>
        </div>

        {/* Input Form */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5" />
              Analysis Parameters
            </CardTitle>
            <CardDescription>Configure your market analysis parameters</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="space-y-2">
                <Label htmlFor="ticker">Ticker Symbol</Label>
                <Input
                  id="ticker"
                  type="text"
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value.toUpperCase())}
                  placeholder="SPY"
                  className="font-mono"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input id="startDate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="volWindow">Volatility Window (Days)</Label>
                <Input
                  id="volWindow"
                  type="number"
                  value={volWindow}
                  onChange={(e) => setVolWindow(e.target.value)}
                  min="5"
                  max="252"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="hurstWindow">Hurst Window (Days)</Label>
                <Input
                  id="hurstWindow"
                  type="number"
                  value={hurstWindow}
                  onChange={(e) => setHurstWindow(e.target.value)}
                  min="20"
                  max="252"
                />
              </div>

              <div className="flex items-end">
                <Button onClick={handleAnalysis} disabled={isLoading} className="w-full" size="lg">
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <TrendingUp className="mr-2 h-4 w-4" />
                      Run Analysis
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Error Display */}
        {error && (
          <Card className="mb-8 border-destructive">
            <CardHeader>
              <CardTitle className="text-destructive">Analysis Error</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Results Display */}
        {result && (
          <div className="space-y-8">
            {/* Summary Card */}
            <Card>
              <CardHeader>
                <CardTitle>Current Market Regime</CardTitle>
                <CardDescription>Analysis as of {result.date}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">Regime</p>
                    <p className="text-2xl font-bold">{result.regime}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {result.daysSinceChange} days • {result.confidence} confidence
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">Strategy</p>
                    <p className="text-2xl font-bold">{result.strategy}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">Volatility</p>
                    <p className="text-2xl font-bold font-mono">{result.volatility}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {result.volPercentile}th percentile
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">Hurst Exponent</p>
                    <p className="text-2xl font-bold font-mono">
                      {result.hurst}
                      <span className="text-sm ml-2 text-muted-foreground">({result.hurstType})</span>
                    </p>
                  </div>
                </div>

                <div className="mt-6 p-4 bg-muted rounded-lg">
                  <p className="text-sm font-medium mb-2">Recommended Action</p>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-semibold">Risk Level: {result.risk}</span>
                    {" • "}
                    {result.description}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Regime Analysis</CardTitle>
                  <CardDescription>Price, volatility, Hurst, and regime classification</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="relative aspect-[4/3] bg-muted rounded-md overflow-hidden">
                    <img
                      src={result.regimePlotUrl || "/placeholder.svg"}
                      alt="Regime Analysis Plot"
                      className="w-full h-full object-contain"
                      onError={(e) => {
                        e.currentTarget.src = "/placeholder.svg?height=600&width=800"
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Regime Statistics</CardTitle>
                  <CardDescription>Comparative performance metrics by regime</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="relative aspect-[4/3] bg-muted rounded-md overflow-hidden">
                    <img
                      src={result.statsPlotUrl || "/placeholder.svg"}
                      alt="Statistics Plot"
                      className="w-full h-full object-contain"
                      onError={(e) => {
                        e.currentTarget.src = "/placeholder.svg?height=600&width=800"
                      }}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!result && !isLoading && !error && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Activity className="w-16 h-16 text-muted-foreground mb-4" />
              <p className="text-lg font-medium mb-2">Ready to Analyze</p>
              <p className="text-sm text-muted-foreground text-center max-w-md">
                Configure your parameters above and click "Run Analysis" to detect volatility regimes
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
