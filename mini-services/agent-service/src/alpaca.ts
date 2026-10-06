/**
 * Alpaca Trading API client wrapper (SDK v4 ergonomic API).
 *
 * Docs: https://alpaca.markets/docs/api-references/alpaca-trading-api/
 *
 * For the Alpaca AI Trading Agents Hackathon we use paper trading by default.
 * Plug in ALPACA_API_KEY and ALPACA_API_SECRET in .env to switch from the
 * deterministic mock to live Alpaca paper trading. NEVER set ALPACA_PAPER=false
 * during a hackathon — the risk guard refuses live orders in this build.
 *
 * The Alpaca MCP server (https://github.com/alpaca-py/alpaca-mcp) and the
 * `alpaca` CLI expose the same primitives via natural language. This file
 * uses the REST SDK so the agent loop stays deterministic and inspectable.
 */

import { Alpaca } from '@alpacahq/alpaca-trade-api'

export interface AlpacaConfig {
  key: string
  secret: string
  paper: boolean
}

export interface PortfolioSummary {
  equity: number
  cash: number
  buyingPower: number
  longMarketValue: number
  shortMarketValue: number
  lastEquity: number
  dailyPnl: number
  dailyPnlPct: number
  isMock: boolean
}

export interface AlpacaPosition {
  symbol: string
  qty: number
  side: string
  avgEntryPrice: number
  currentPrice: number
  marketValue: number
  unrealizedPnl: number
  unrealizedPnlPct: number
}

const MOCK_INITIAL_EQUITY = 100000

class MockAlpacaClient {
  private equity = MOCK_INITIAL_EQUITY
  private positions = new Map<string, AlpacaPosition>()
  private priceMap = new Map<string, number>()

  private getRefPrice(symbol: string): number {
    if (!this.priceMap.has(symbol)) {
      this.priceMap.set(symbol, 80 + Math.floor(Math.random() * 420))
    }
    const base = this.priceMap.get(symbol)!
    // tiny random walk each call
    const next = Math.max(5, base * (1 + (Math.random() - 0.5) * 0.02))
    this.priceMap.set(symbol, next)
    return next
  }

  async getAccount(): Promise<PortfolioSummary> {
    const longMarketValue = Array.from(this.positions.values())
      .filter((p) => p.side === 'long')
      .reduce((s, p) => s + p.marketValue, 0)
    const shortMarketValue = Array.from(this.positions.values())
      .filter((p) => p.side === 'short')
      .reduce((s, p) => s + p.marketValue, 0)
    const cash = this.equity - longMarketValue + shortMarketValue
    return {
      equity: this.equity,
      cash,
      buyingPower: cash * 4,
      longMarketValue,
      shortMarketValue,
      lastEquity: this.equity,
      dailyPnl: 0,
      dailyPnlPct: 0,
      isMock: true,
    }
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    // Refresh prices for live P&L feel
    for (const [sym, pos] of this.positions.entries()) {
      const px = this.getRefPrice(sym)
      pos.currentPrice = px
      pos.marketValue = pos.qty * px
      pos.unrealizedPnl = (px - pos.avgEntryPrice) * pos.qty
      pos.unrealizedPnlPct = pos.avgEntryPrice > 0 ? (px / pos.avgEntryPrice - 1) * 100 : 0
      this.positions.set(sym, pos)
    }
    return Array.from(this.positions.values())
  }

  async submitMarketOrder(
    symbol: string,
    qty: number,
    side: 'buy' | 'sell',
  ): Promise<{ id: string; status: string }> {
    const price = this.getRefPrice(symbol)
    if (side === 'buy') {
      const existing = this.positions.get(symbol)
      if (existing) {
        const newQty = existing.qty + qty
        const newAvg = (existing.avgEntryPrice * existing.qty + price * qty) / newQty
        this.positions.set(symbol, {
          symbol,
          qty: newQty,
          side: 'long',
          avgEntryPrice: newAvg,
          currentPrice: price,
          marketValue: newQty * price,
          unrealizedPnl: (price - newAvg) * newQty,
          unrealizedPnlPct: (price / newAvg - 1) * 100,
        })
      } else {
        this.positions.set(symbol, {
          symbol,
          qty,
          side: 'long',
          avgEntryPrice: price,
          currentPrice: price,
          marketValue: qty * price,
          unrealizedPnl: 0,
          unrealizedPnlPct: 0,
        })
      }
    } else {
      const existing = this.positions.get(symbol)
      if (existing) {
        const newQty = existing.qty - qty
        if (newQty <= 0.0001) {
          this.positions.delete(symbol)
        } else {
          existing.qty = newQty
          existing.marketValue = newQty * price
          existing.currentPrice = price
          existing.unrealizedPnl = (price - existing.avgEntryPrice) * newQty
          existing.unrealizedPnlPct = (price / existing.avgEntryPrice - 1) * 100
          this.positions.set(symbol, existing)
        }
      }
    }
    return { id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status: 'filled' }
  }

  async closePosition(symbol: string): Promise<void> {
    this.positions.delete(symbol)
  }
}

class RealAlpacaClient {
  private client: Alpaca
  constructor(cfg: AlpacaConfig) {
    // Alpaca SDK v4 expects `keyId` + `secret` (not `key` + `secret`).
    this.client = new Alpaca({
      keyId: cfg.key,
      secret: cfg.secret,
      paper: cfg.paper,
    })
  }

  async getAccount(): Promise<PortfolioSummary> {
    const account = await this.client.trading.account.getAccount()
    const equity = Number(account.equity ?? 0)
    const lastEquity = Number(account.lastEquity ?? equity)
    return {
      equity,
      cash: Number(account.cash ?? 0),
      buyingPower: Number(account.buyingPower ?? 0),
      longMarketValue: Number(account.longMarketValue ?? 0),
      shortMarketValue: Number(account.shortMarketValue ?? 0),
      lastEquity,
      dailyPnl: equity - lastEquity,
      dailyPnlPct: lastEquity > 0 ? (equity / lastEquity - 1) * 100 : 0,
      isMock: false,
    }
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    const positions = await this.client.trading.positions.getAllOpenPositions()
    // SDK v4 models are camelCase (avgEntryPrice, currentPrice, unrealizedPl).
    return positions.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      side: p.side,
      avgEntryPrice: Number(p.avgEntryPrice ?? 0),
      currentPrice: Number(p.currentPrice ?? 0),
      marketValue: Number(p.marketValue ?? 0),
      unrealizedPnl: Number(p.unrealizedPl ?? 0),
      unrealizedPnlPct: Number(p.unrealizedPlpc ?? 0) * 100,
    }))
  }

  async submitMarketOrder(
    symbol: string,
    qty: number,
    side: 'buy' | 'sell',
  ): Promise<{ id: string; status: string }> {
    // Use the ergonomic `market` helper. Note: Alpaca paper only fills market
    // orders during market hours (9:30–16:00 ET, Mon–Fri). When the market is
    // closed the order will be accepted (status='new') and fill on next open.
    // We submit with `timeInForce: 'day'` so unfilled orders auto-cancel at
    // market close — paper account never accumulates stale orders.
    const order = await this.client.trading.orders.market({
      symbol,
      qty,
      side,
      timeInForce: 'day',
      clientOrderId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    })
    const id = order.id ?? 'unknown'
    const status = order.status ?? 'new'

    // If accepted but not filled, fetch the latest status once more.
    // v4 names this getOrderByOrderID (there is no getOrder).
    if (status === 'new' || status === 'pending_new' || status === 'accepted') {
      try {
        const refreshed = await this.client.trading.orders.getOrderByOrderID({ orderId: id })
        return { id, status: refreshed.status ?? status }
      } catch {
        // Ignore — return the original status
      }
    }
    return { id, status }
  }

  async closePosition(symbol: string): Promise<void> {
    // v4 closes a position via DELETE /v2/positions/{symbol_or_asset_id}.
    await this.client.trading.positions.deleteOpenPosition({ symbolOrAssetId: symbol })
  }
}

export type AlpacaClient = MockAlpacaClient | RealAlpacaClient

let _client: AlpacaClient | null = null

export function getAlpacaClient(): AlpacaClient {
  if (_client) return _client
  const key = process.env.ALPACA_API_KEY
  const secret = process.env.ALPACA_API_SECRET
  const paper = (process.env.ALPACA_PAPER ?? 'true') !== 'false'
  if (key && secret) {
    console.log(`[alpaca] using Alpaca Trading API client (paper=${paper})`)
    _client = new RealAlpacaClient({ key, secret, paper })
  } else {
    console.warn('[alpaca] ALPACA_API_KEY/ALPACA_API_SECRET not set — using mock client for demo')
    _client = new MockAlpacaClient()
  }
  return _client
}
