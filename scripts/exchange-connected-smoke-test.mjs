import puppeteer from 'puppeteer-core'

const appPort = process.argv[2] || '5173'
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
})

const position = {
  symbol: 'BTC-USDT', positionId: '12345678901234567890', positionSide: 'LONG', isolated: false,
  positionAmt: '0.01', availableAmt: '0.01', unrealizedProfit: '12.50', initialMargin: '300',
  liquidationPrice: 42000, avgPrice: '60000', leverage: 20, positionValue: '600', currency: 'USDT',
}
const openOrder = {
  orderId: '88888888888888888888', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', type: 'LIMIT',
  price: '59000', quantity: '0.01', executedQty: '0', status: 'NEW', time: Date.now(), clientOrderId: 'ui-smoke-order',
}
const stopOrder = {
  orderId: '88888888888888888889', symbol: 'BTC-USDT', side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET',
  stopPrice: '57000', origQty: '0.006', executedQty: '0', status: 'NEW', time: Date.now(), clientOrderId: 'ui-smoke-stop', workingType: 'MARK_PRICE',
}
const secondStopOrder = { ...stopOrder, orderId: '88888888888888888890', origQty: '0.004', clientOrderId: 'ui-smoke-stop-2' }
const snapshot = {
  balances: [{ asset: 'USDT', balance: '1000', equity: '1012.5', unrealizedProfit: '12.5', availableMargin: '700', usedMargin: '300' }],
  positions: [position], openOrders: [openOrder, stopOrder, secondStopOrder], dualSidePosition: true, updatedAt: Date.now(),
}
const session = {
  connected: true, accountId: 'ui-smoke-account', exchange: 'bingx', environment: 'prod-live', label: 'UI smoke account', apiKeyMask: '••••1234',
  connectedAt: Date.now(), liveTradingEnabled: true, liveTriggerOrdersEnabled: false, snapshot,
}
const accounts = [{
  id: session.accountId, userId: 'ui-smoke-user', exchange: 'bingx', environment: 'prod-live',
  label: session.label, apiKeyMask: session.apiKeyMask, status: 'ACTIVE', isDefault: true,
  connectedAt: session.connectedAt, lastVerifiedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
}]
let settings = {
  symbol: 'BTC-USDT', marginType: 'CROSSED', longLeverage: 20, shortLeverage: 20,
  maxLongLeverage: 50, maxShortLeverage: 40, dualSidePosition: true,
  contract: {
    symbol: 'BTC-USDT', quantityPrecision: 3, pricePrecision: 1, makerFeeRate: 0.0002,
    takerFeeRate: 0.0005, tradeMinQuantity: 0.001, tradeMinUSDT: 5,
    maxLongLeverage: 50, maxShortLeverage: 40, status: 1, apiStateOpen: 'true', apiStateClose: 'true', asset: 'BTC', currency: 'USDT',
  },
  prices: { markPrice: 60000, indexPrice: 59995, bidPrice: 59990, askPrice: 60000 }, updatedAt: Date.now(),
}
const riskProfile = {
  active: true,
  timezone: 'Europe/Warsaw',
  externalViolationPolicy: 'BLOCK_NEW_ENTRIES',
  breachAction: 'BLOCK_NEW_ENTRIES',
  automationConsent: false,
  fixedStopLoss: { enabled: false, value: 2, workingType: 'MARK_PRICE' },
  breakEven: { enabled: false, triggerMode: 'PERCENT', triggerValue: 2, offsetPercent: 0.05 },
  riskPerTrade: { enabled: true, value: 1 },
  dailyLossLimit: { enabled: true, value: 3, unit: 'PERCENT' },
  maxLeverage: { enabled: true, value: 10 },
  maxTradesPerDay: { enabled: true, value: 6 },
  maxConsecutiveLosses: { enabled: false, value: 3 },
  cooldownMinutes: { enabled: false, value: 30 },
  maxExposurePercent: { enabled: false, value: 100 },
  maxOpenPositions: { enabled: false, value: 3 },
  updatedAt: Date.now(),
}
let riskRuntime = { active: true, enforcing: true, blocked: false, workerStatus: 'RUNNING', lastCheckedAt: Date.now() }
const captured = { preview: null, execute: null, close: null, cancel: null, amend: null, margin: null, leverage: null, protection: null }
let previewRequests = 0

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) {
      request.continue()
      return
    }
    const payload = request.postData() ? JSON.parse(request.postData()) : null
    let status = 200
    let responseBody = {}
    if (url.pathname === '/api/auth/session') {
      responseBody = { authenticated: true, user: { id: 'ui-smoke-user', email: 'trader@example.com', createdAt: Date.now() } }
    } else if (url.pathname === '/api/risk/profile') {
      responseBody = riskProfile
    } else if (url.pathname === '/api/risk/status') {
      responseBody = riskRuntime
    } else if (url.pathname === '/api/risk/events') {
      responseBody = []
    } else if (url.pathname === '/api/exchange/session' || url.pathname === '/api/exchange/account') {
      responseBody = session
    } else if (url.pathname === '/api/exchange/accounts') {
      responseBody = { accounts }
    } else if (url.pathname === '/api/account/history') {
      responseBody = {
        orderHistory: [{ orderId: '7001', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', price: '0', avgPrice: '60000', quantity: '0.01', executedQty: '0.01', status: 'FILLED', realizedPnl: '3.5', fee: '-0.03', time: Date.now() - 2_000, updateTime: Date.now() - 1_000 }],
        tradeHistory: [{ tradeId: '8001', orderId: '7001', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', price: '60000', quantity: '0.01', realizedPnl: '3.5', fee: '-0.03', time: Date.now() - 1_000 }],
        synchronizedAt: Date.now(), warnings: [],
      }
    } else if (url.pathname === '/api/exchange/contracts') {
      responseBody = { exchange: 'bingx', contracts: [settings.contract, { ...settings.contract, symbol: 'HYPE-USDT', asset: 'HYPE' }], updatedAt: Date.now() }
    } else if (url.pathname.endsWith('/settings')) {
      responseBody = settings
    } else if (url.pathname.endsWith('/margin')) {
      captured.margin = payload
      settings = { ...settings, marginType: payload.marginType, updatedAt: Date.now() }
      responseBody = settings
    } else if (url.pathname.endsWith('/leverage')) {
      captured.leverage = payload
      settings = { ...settings, longLeverage: payload.leverage, updatedAt: Date.now() }
      responseBody = settings
    } else if (url.pathname === '/api/exchange/orders/preview') {
      previewRequests += 1
      captured.preview = payload
      responseBody = {
        previewId: `preview-for-connected-ui-smoke-test-${previewRequests}`,
        expiresAt: Date.now() + (previewRequests === 1 ? 150 : 30000),
        preview: {
          symbol: 'BTC-USDT', direction: payload.direction, orderKind: payload.orderKind,
          exchangeOrderType: payload.orderKind, amountMode: payload.amountMode, quantity: 0.00166667,
          notional: 100, estimatedMargin: 6.6667, estimatedOpenFee: 0.05, estimatedCloseFee: 0.05,
          estimatedOrderCost: 6.7667, estimatedAveragePrice: 60000, estimatedSlippagePercent: 0.012,
          indicativeLiquidationPrice: 56000, marginType: payload.marginType, leverage: payload.leverage,
          maker: false, triggerLiveVerified: true,
          ...(payload.takeProfit ? { takeProfit: { ...payload.takeProfit, expectedPnl: 1.25 } } : {}),
          ...(payload.stopLoss ? { stopLoss: { ...payload.stopLoss, expectedPnl: 0.625 } } : {}),
          ...(payload.takeProfit && payload.stopLoss ? { riskReward: 2 } : {}),
        },
      }
    } else if (url.pathname === '/api/exchange/orders' && request.method() === 'POST') {
      captured.execute = payload
      status = 201
      const hedgeEntry = settings.prices.markPrice
      const hedgeStop = Number(captured.preview?.stopLoss?.stopPrice) || hedgeEntry * 1.003
      const hedgeSnapshot = captured.preview?.direction === 'SHORT'
        ? {
            ...snapshot,
            positions: [...snapshot.positions, {
              ...position,
              positionId: '12345678901234567891',
              positionSide: 'SHORT',
              positionAmt: '-0.00166667',
              availableAmt: '0.00166667',
              avgPrice: String(hedgeEntry),
              positionValue: '100',
            }],
            openOrders: [...snapshot.openOrders, {
              ...stopOrder,
              orderId: '88888888888888888891',
              side: 'BUY',
              positionSide: 'SHORT',
              stopPrice: String(hedgeStop),
              origQty: '0.00166667',
              clientOrderId: 'antytilt-protect-ui-smoke-short',
            }],
          }
        : snapshot
      responseBody = { order: { orderID: '99999999999999999999', status: 'FILLED' }, snapshot: hedgeSnapshot }
    } else if (url.pathname.includes('/positions/') && url.pathname.endsWith('/close')) {
      captured.close = payload
      status = 201
      responseBody = { order: { orderID: '777' }, snapshot }
    } else if (url.pathname.includes('/positions/') && url.pathname.endsWith('/protection')) {
      captured.protection = payload
      responseBody = { order: { orderID: '778', type: 'STOP_MARKET', stopPrice: payload.stopPrice }, snapshot: { ...snapshot, openOrders: [openOrder, { ...stopOrder, stopPrice: String(payload.stopPrice) }, secondStopOrder] } }
    } else if (url.pathname.endsWith('/amend') && request.method() === 'POST') {
      captured.amend = payload
      responseBody = { order: { orderId: openOrder.orderId, quantity: String(payload.quantity) }, snapshot }
    } else if (url.pathname.includes('/orders/') && request.method() === 'DELETE') {
      captured.cancel = payload
      responseBody = { order: { orderId: openOrder.orderId }, snapshot: { ...snapshot, openOrders: [] } }
    }
    request.respond({ status, contentType: 'application/json', body: JSON.stringify(responseBody) })
  })

  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${appPort}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('.connect-button')?.textContent?.includes('BingX Live'))
  await page.waitForFunction(() => document.querySelector('.leverage-button')?.textContent?.includes('20x'))
  await page.waitForFunction(() => document.querySelector('.pretrade-risk-status')?.textContent?.includes('Risk Guard active'))
  const readTerminalGeometry = () => page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect()
      return value ? { left: value.left, top: value.top, width: value.width, height: value.height } : null
    }
    return {
      chart: rect('.chart-panel'),
      market: rect('.market-column'),
      bottom: rect('.bottom-panel'),
      terminal: rect('.terminal-layout'),
      documentWidth: document.documentElement.clientWidth,
      documentHeight: document.documentElement.scrollHeight,
    }
  })
  const settleLayout = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const maxGeometryDelta = (reference, sample) => {
    const values = ['chart', 'market', 'bottom', 'terminal'].flatMap((key) => ['left', 'top', 'width', 'height'].map((field) => Math.abs(reference[key][field] - sample[key][field])))
    values.push(Math.abs(reference.documentWidth - sample.documentWidth), Math.abs(reference.documentHeight - sample.documentHeight))
    return Math.max(...values)
  }
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== 'dark') {
    await page.click('.app-header .theme-toggle')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  }
  const darkThemeGeometry = await readTerminalGeometry()
  await page.click('.app-header .theme-toggle')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await settleLayout()
  await new Promise((resolve) => setTimeout(resolve, 220))
  const lightThemeGeometry = await readTerminalGeometry()
  const lightThemeStyles = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    storedTheme: localStorage.getItem('antytilt:theme'),
    body: getComputedStyle(document.body).backgroundColor,
    header: getComputedStyle(document.querySelector('.app-header')).backgroundColor,
    chart: getComputedStyle(document.querySelector('.chart-viewport')).backgroundColor,
    orderPanel: getComputedStyle(document.querySelector('.order-panel')).backgroundColor,
    text: getComputedStyle(document.querySelector('.instrument-name')).color,
    positionsHead: getComputedStyle(document.querySelector('.positions-head')).backgroundColor,
    positionsRow: getComputedStyle(document.querySelector('.positions-table:not(.positions-head)')).backgroundColor,
    bottomAction: getComputedStyle(document.querySelector('.bottom-actions button')).backgroundColor,
  }))
  await page.waitForFunction(() => !document.querySelector('.chart-data-state'), { timeout: 15_000 })
  await page.click('[aria-label="Price range · M"]')
  const measureViewport = await page.$eval('.chart-viewport', (element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
  const measureStart = {
    x: measureViewport.left + measureViewport.width * 0.34,
    y: measureViewport.top + measureViewport.height * 0.66,
  }
  const measureEnd = {
    x: measureViewport.left + measureViewport.width * 0.59,
    y: measureViewport.top + measureViewport.height * 0.39,
  }
  await page.$eval('.drawing-overlay', (overlay, points) => {
    const dispatch = (type, point, buttons) => overlay.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons,
      pointerId: 31,
      pointerType: 'mouse',
      isPrimary: true,
    }))
    dispatch('pointerdown', points.start, 1)
    for (let step = 1; step <= 8; step += 1) {
      dispatch('pointermove', {
        x: points.start.x + (points.end.x - points.start.x) * step / 8,
        y: points.start.y + (points.end.y - points.start.y) * step / 8,
      }, 1)
    }
    dispatch('pointerup', points.end, 0)
  }, { start: measureStart, end: measureEnd })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const measureCreated = await page.$('.drawing-measure-card')
  if (!measureCreated) {
    const diagnostic = await page.evaluate(() => ({
      activeTool: document.querySelector('.drawing-toolbar')?.getAttribute('data-active-tool'),
      overlayClass: document.querySelector('.drawing-overlay')?.getAttribute('class'),
      previews: document.querySelectorAll('.chart-drawing.preview').length,
      drawings: document.querySelectorAll('.chart-drawing:not(.preview)').length,
    }))
    throw new Error(`Ruler drag did not finish: ${JSON.stringify({ ...diagnostic, pageErrors: errors })}`)
  }
  const measureGesture = await page.evaluate(() => {
    const card = document.querySelector('.drawing-measure-card')
    const overlay = document.querySelector('.drawing-overlay')
    const cardX = Number(card?.getAttribute('x'))
    const cardY = Number(card?.getAttribute('y'))
    const cardWidth = Number(card?.getAttribute('width'))
    const cardHeight = Number(card?.getAttribute('height'))
    const plotWidth = (overlay?.viewBox.baseVal.width ?? 0) - 55
    const plotHeight = (overlay?.viewBox.baseVal.height ?? 0) - 25
    return {
      text: document.querySelector('.drawing-measure-label')?.textContent?.replace(/\s+/g, ' ').trim(),
      previewRemaining: Boolean(document.querySelector('.chart-drawing.preview')),
      anchors: document.querySelectorAll('.chart-drawing.selected .drawing-anchor').length,
      diagonal: Boolean(document.querySelector('.drawing-measure-diagonal')),
      connector: Boolean(document.querySelector('.drawing-measure-connector')),
      propertyRows: document.querySelectorAll('.drawing-properties .drawing-property-row').length,
      cardInsidePlot: cardX >= 0 && cardY >= 0 && cardX + cardWidth <= plotWidth && cardY + cardHeight <= plotHeight,
    }
  })
  await page.screenshot({ path: '/tmp/antytilt-light-ruler.png', fullPage: true })
  await page.keyboard.press('Delete')
  await page.waitForFunction(() => !document.querySelector('.drawing-measure-card'))
  await page.click('.order-types button:nth-child(3)')
  await settleLayout()
  const triggerLightControls = await page.evaluate(() => {
    const colors = (selector) => {
      const style = getComputedStyle(document.querySelector(selector))
      return { color: style.color, background: style.backgroundColor, border: style.borderColor }
    }
    return {
      label: document.querySelector('.trigger-block .compact-setting-row > span')?.textContent,
      options: [...document.querySelectorAll('.trigger-block select option')].map((option) => option.textContent),
      available: document.querySelector('.order-balance strong')?.textContent,
      priceInput: colors('.trigger-block .input-shell'),
      source: colors('.trigger-block select'),
      executionTrack: colors('.trigger-block .segmented-control'),
      activeExecution: colors('.trigger-block .segmented-control button.active'),
    }
  })
  await page.screenshot({ path: '/tmp/antytilt-light-trigger-controls.png', fullPage: true })
  await page.click('.order-types button:nth-child(2)')
  await settleLayout()
  await page.screenshot({ path: '/tmp/antytilt-light-theme.png', fullPage: true })
  await page.click('.app-header .theme-toggle')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await settleLayout()
  const restoredDarkGeometry = await readTerminalGeometry()
  const themeSwitch = {
    light: lightThemeStyles,
    maxLayoutShift: Math.max(
      maxGeometryDelta(darkThemeGeometry, lightThemeGeometry),
      maxGeometryDelta(darkThemeGeometry, restoredDarkGeometry),
    ),
    restoredTheme: await page.evaluate(() => document.documentElement.dataset.theme),
    storedTheme: await page.evaluate(() => localStorage.getItem('antytilt:theme')),
  }
  const terminalGeometry = { market: await readTerminalGeometry() }
  await page.click('.order-types button:nth-child(1)')
  await settleLayout()
  terminalGeometry.limit = await readTerminalGeometry()
  await page.click('.order-types button:nth-child(3)')
  await settleLayout()
  terminalGeometry.triggerMarket = await readTerminalGeometry()
  await page.click('.trigger-block .segmented-control button:nth-child(2)')
  await settleLayout()
  terminalGeometry.triggerLimit = await readTerminalGeometry()
  await page.click('.order-types button:nth-child(2)')
  await settleLayout()
  terminalGeometry.maxOrderTypeShift = Math.max(
    maxGeometryDelta(terminalGeometry.market, terminalGeometry.limit),
    maxGeometryDelta(terminalGeometry.market, terminalGeometry.triggerMarket),
    maxGeometryDelta(terminalGeometry.market, terminalGeometry.triggerLimit),
  )
  const ctaBeforeAmount = await page.$eval('.place-order', (button) => ({ text: button.textContent, disabled: button.disabled }))
  const visibleMarketPrice = await page.$eval('.instrument-price strong', (element) => Number(element.textContent?.replaceAll(',', '')))
  if (visibleMarketPrice > 0) {
    position.avgPrice = String(visibleMarketPrice)
    position.liquidationPrice = visibleMarketPrice * 0.7
    stopOrder.stopPrice = String(visibleMarketPrice * 0.99996)
    settings.prices.markPrice = visibleMarketPrice
    settings.prices.bidPrice = visibleMarketPrice
    settings.prices.askPrice = visibleMarketPrice
  }
  await new Promise((resolve) => setTimeout(resolve, 5_300))
  await page.waitForSelector('.trade-protection-line.stop-loss')
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })

  const markerCollision = await page.evaluate(() => {
    const markerSelectors = [
      '[data-trade-level="current"]',
      '[data-trade-level="position"][data-position-side="LONG"]',
      '.trade-protection-line.stop-loss',
    ]
    const markers = markerSelectors.map((selector) => document.querySelector(selector)).filter(Boolean)
    const centers = markers.map((marker) => {
      const rect = marker.querySelector('.chart-trade-level-label').getBoundingClientRect()
      return rect.top + rect.height / 2
    }).sort((left, right) => left - right)
    const gaps = centers.slice(1).map((center, index) => center - centers[index])
    const stopLabel = document.querySelector('.trade-protection-line.stop-loss .chart-trade-level-label')
    return {
      count: markers.length,
      minGap: gaps.length ? Math.min(...gaps) : 0,
      connectors: markers.filter((marker) => {
        const connector = marker.querySelector('.chart-trade-level-connector')
        return connector && connector.getBoundingClientRect().height > 1
      }).length,
      tradeZ: Number(getComputedStyle(document.querySelector('[data-trade-level="current"]')).zIndex),
      drawingZ: Number(getComputedStyle(document.querySelector('.drawing-overlay')).zIndex),
      compactStop: stopLabel?.textContent?.replace(/\s+/g, ' ').trim(),
      tooltip: stopLabel?.getAttribute('data-tooltip'),
    }
  })
  await page.hover('.trade-protection-line.stop-loss .chart-trade-level-label')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const markerTooltipVisible = await page.$eval('.trade-protection-line.stop-loss .chart-trade-level-label', (label) => {
    const tooltipStyle = getComputedStyle(label, '::after')
    return tooltipStyle.opacity === '1' && tooltipStyle.visibility === 'visible'
  })

  const stopLine = await page.$eval('.trade-protection-line.stop-loss', (element) => {
    const hit = element.querySelector('.chart-trade-level-hit')
    const rect = hit.getBoundingClientRect()
    const style = getComputedStyle(element)
    const x = rect.left + Math.min(180, rect.width / 2)
    const y = rect.top + rect.height / 2
    return { x, y, top: rect.top, bottom: rect.bottom, hit: document.elementFromPoint(x, y)?.className, color: style.color, label: element.querySelector('strong')?.textContent }
  })
  await page.mouse.move(stopLine.x, stopLine.y)
  await page.mouse.down()
  await page.mouse.move(stopLine.x, stopLine.y - 22, { steps: 4 })
  const draggedStopLineLight = await page.$eval('.trade-protection-line.stop-loss.dragging', (element) => {
    const label = element.querySelector('.chart-trade-level-label')
    const style = getComputedStyle(label)
    return {
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      priceColor: getComputedStyle(label.querySelector(':scope > span')).color,
      label: element.querySelector('strong')?.textContent,
    }
  })
  await page.screenshot({ path: '/tmp/antytilt-light-stop-drag.png', fullPage: true })
  await page.mouse.up()
  await page.waitForSelector('.chart-trade-modal')
  await page.select('.chart-trade-modal-body label select', stopOrder.orderId)
  const protectionDialogLight = await page.evaluate(() => {
    const colors = (selector) => {
      const style = getComputedStyle(document.querySelector(selector))
      return { color: style.color, background: style.backgroundColor, border: style.borderColor }
    }
    return {
      modal: colors('.chart-trade-modal'),
      title: colors('.chart-trade-modal header strong'),
      summary: colors('.protection-price-change'),
      input: colors('.chart-trade-modal-body input'),
      select: colors('.chart-trade-modal-body select'),
      note: colors('.chart-trade-modal-body p:last-of-type'),
      cancel: colors('.chart-trade-modal footer button:first-child'),
      confirm: colors('.chart-trade-modal footer button:last-child'),
    }
  })
  await page.screenshot({ path: '/tmp/antytilt-light-protection-dialog.png', fullPage: true })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.click('.chart-trade-modal footer button:last-child')
  await page.waitForFunction(() => !document.querySelector('.chart-trade-modal'))

  await page.click('.instrument-name')
  await page.waitForSelector('.market-selector')
  await page.waitForFunction(() => [...document.querySelectorAll('.market-coin img')].every((image) => image.complete), { timeout: 8_000 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  const marketSelectorLight = await page.evaluate(() => {
    const colors = (selector) => {
      const style = getComputedStyle(document.querySelector(selector))
      return { color: style.color, background: style.backgroundColor, border: style.borderColor }
    }
    return {
      modal: colors('.market-selector'),
      title: colors('.market-selector-head strong'),
      search: colors('.market-search'),
      listHead: colors('.market-list-head'),
      selectedRow: colors('.market-row.selected'),
      footer: colors('.market-selector-footer'),
    }
  })
  await page.screenshot({ path: '/tmp/antytilt-light-market-selector.png', fullPage: true })
  const executableCatalog = await page.evaluate(() => ({
    count: document.querySelectorAll('.market-row').length,
    subtitle: document.querySelector('.market-selector-head span')?.textContent,
    bingxBadges: document.querySelectorAll('.exchange-availability .bingx').length,
    logos: document.querySelectorAll('.market-coin').length,
    loadedLogos: [...document.querySelectorAll('.market-coin img')].filter((image) => image.naturalWidth > 0).length,
    fallbackLogos: document.querySelectorAll('.market-coin.coin-image-fallback').length,
    selectedLogoLoaded: document.querySelector('.coin-logo img')?.naturalWidth > 0,
  }))
  await page.click('.market-row.selected')
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })

  await page.click('.app-header .theme-toggle')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await new Promise((resolve) => setTimeout(resolve, 220))
  await page.click('.order-topline button:first-child')
  await page.waitForSelector('.margin-modal')
  await new Promise((resolve) => setTimeout(resolve, 220))
  const marginHasTypedConfirmation = await page.$('.margin-modal .trade-confirm-field') !== null
  const marginLightDialog = await page.evaluate(() => {
    const colors = (selector) => {
      const style = getComputedStyle(document.querySelector(selector))
      return { color: style.color, background: style.backgroundColor, border: style.borderColor }
    }
    return {
      title: colors('.margin-modal .trade-modal-header strong'),
      selectedCard: colors('.margin-modal .mode-card.selected'),
      defaultCard: colors('.margin-modal .mode-card:not(.selected)'),
      info: colors('.margin-modal .modal-info'),
      cancel: colors('.margin-modal .trade-modal-actions button:first-child'),
      disabledConfirm: colors('.margin-modal .trade-modal-actions .primary'),
    }
  })
  await page.screenshot({ path: '/tmp/antytilt-light-margin-modal.png', fullPage: true })
  await page.click('.mode-card:nth-child(2)')
  await page.click('.margin-modal .trade-modal-actions .primary')
  await page.waitForFunction(() => !document.querySelector('.margin-modal'))

  await page.click('.leverage-button')
  await page.waitForSelector('.leverage-modal')
  const leverageHasTypedConfirmation = await page.$('.leverage-modal .trade-confirm-field') !== null
  const leverageMarkers = await page.$$eval('.leverage-markers button', (buttons) => buttons.map((button) => ({
    value: Number(button.textContent?.replace('x', '')),
    left: Number.parseFloat(button.style.left),
  })))
  const leverageCopy = await page.$eval('.leverage-modal', (element) => element.textContent)
  await page.$eval('.leverage-range-block > input', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '35')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const leverageLightDialog = await page.evaluate(() => {
    const colors = (selector) => {
      const style = getComputedStyle(document.querySelector(selector))
      return { color: style.color, background: style.backgroundColor, border: style.borderColor }
    }
    return {
      title: colors('.leverage-modal .trade-modal-header strong'),
      stepButton: colors('.leverage-modal .leverage-input-row > button'),
      input: colors('.leverage-modal .leverage-input-row label'),
      value: colors('.leverage-modal .leverage-input-row input'),
      cancel: colors('.leverage-modal .trade-modal-actions button:first-child'),
      confirm: colors('.leverage-modal .trade-modal-actions .primary'),
    }
  })
  await page.screenshot({ path: '/tmp/antytilt-light-leverage-modal.png', fullPage: true })
  await page.click('.leverage-modal .trade-modal-actions .primary')
  await page.waitForFunction(() => !document.querySelector('.leverage-modal'))
  await page.click('.app-header .theme-toggle')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await settleLayout()

  await page.$eval('.percentage-control > input', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '38')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const selectedPercent = await page.$eval('.order-size-percent', (element) => element.textContent)
  await page.$eval('.amount-input input', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '100')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.click('.protection-master-switch')
  await page.click('.protection-toolbar button:nth-child(2)')
  const protectionGeometry = { collapsed: await readTerminalGeometry() }
  await page.click('.protection-advanced-toggle')
  await settleLayout()
  protectionGeometry.market = await readTerminalGeometry()
  await page.click('.protection-execution button:nth-child(2)')
  await settleLayout()
  protectionGeometry.limit = await readTerminalGeometry()
  await page.click('.protection-execution button:nth-child(1)')
  await page.click('.protection-advanced-toggle')
  await settleLayout()
  protectionGeometry.maxExecutionShift = Math.max(
    maxGeometryDelta(protectionGeometry.collapsed, protectionGeometry.market),
    maxGeometryDelta(protectionGeometry.collapsed, protectionGeometry.limit),
  )
  const protectionInputs = await page.$$('.protection-leg-grid input')
  await protectionInputs[0].type('1')
  await protectionInputs[1].type('0.5')
  await page.waitForFunction(() => document.querySelectorAll('.trade-protection-line.order-draft').length === 0)
  const sameSideDraftSuppressed = await page.$eval('.chart-viewport', () => document.querySelectorAll('.trade-protection-line.order-draft').length === 0)
  await page.click('.side-switch button:nth-child(2)')
  await page.waitForFunction(() => document.querySelectorAll('.trade-protection-line.order-draft').length === 2)
  const chartProtectionPnl = await page.evaluate(() => ({
    draft: [...document.querySelectorAll('.trade-protection-line.order-draft')].map((line) => ({
      type: line.classList.contains('take-profit') ? 'TP' : 'SL',
      text: line.textContent?.replace(/\s+/g, ' ').trim(),
      top: Number.parseFloat(line.style.top),
    })),
    existing: [...document.querySelectorAll('.trade-protection-line:not(.order-draft)')].map((line) => line.textContent?.replace(/\s+/g, ' ').trim()),
  }))
  await page.click('.side-switch button:nth-child(1)')
  await page.waitForFunction(() => document.querySelectorAll('.trade-protection-line.order-draft').length === 0)
  const sameSideDraftStillSuppressed = await page.$eval('.chart-viewport', () => document.querySelectorAll('.trade-protection-line.order-draft').length === 0)
  await page.click('.side-switch button:nth-child(2)')
  await page.waitForFunction(() => document.querySelectorAll('.trade-protection-line.order-draft').length === 2)
  await page.$eval('.amount-input input', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForFunction(() => document.querySelectorAll('.trade-protection-line.order-draft').length === 0)
  const zeroQuantityDraftHidden = await page.$eval('.chart-viewport', () => document.querySelectorAll('.trade-protection-line.order-draft').length === 0)
  await page.$eval('.amount-input input', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '100')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForFunction(() => document.querySelectorAll('.trade-protection-line.order-draft').length === 2)
  await page.click('.app-header .theme-toggle')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.click('.protection-advanced-toggle')
  await settleLayout()
  await new Promise((resolve) => setTimeout(resolve, 220))
  const protectionLightControls = await page.evaluate(() => {
    const colors = (selector) => {
      const style = getComputedStyle(document.querySelector(selector))
      return { color: style.color, background: style.backgroundColor, border: style.borderColor }
    }
    return {
      label: document.querySelector('.protection-toolbar label > span')?.textContent,
      selectedSource: document.querySelector('.protection-toolbar select')?.selectedOptions?.[0]?.textContent,
      source: colors('.protection-toolbar select'),
      modeTrack: colors('.protection-toolbar > div'),
      activeMode: colors('.protection-toolbar button.active'),
      executionTrack: colors('.protection-execution > div'),
      activeExecution: colors('.protection-execution button.active'),
      advancedPanel: colors('.protection-advanced'),
    }
  })
  await page.screenshot({ path: '/tmp/antytilt-light-protection-controls.png', fullPage: true })
  await page.click('.protection-advanced-toggle')
  await page.click('.app-header .theme-toggle')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await settleLayout()
  const redesignedOrderEntry = await page.evaluate(() => ({
    presets: [...document.querySelectorAll('.percentage-presets button')].map((button) => button.textContent),
    hasDuplicatePercentageInput: document.querySelector('.percentage-footer') !== null,
    hasRangeMarkers: document.querySelector('.range-reference-points') !== null,
    protectionCards: document.querySelectorAll('.protection-leg').length,
    summaryColumns: document.querySelectorAll('.order-size-summary > span').length,
    riskStatus: document.querySelector('.pretrade-risk-status')?.textContent?.replace(/\s+/g, ' ').trim(),
  }))
  await page.screenshot({ path: '/tmp/antytilt-order-entry-redesign.png', fullPage: true })
  await page.click('.place-order.sell')
  await page.waitForSelector('.confirmation-modal')
  const orderHasTypedConfirmation = await page.$('.confirmation-modal .trade-confirm-field') !== null
  await new Promise((resolve) => setTimeout(resolve, 300))
  await page.waitForFunction(() => document.querySelector('.confirmation-modal .trade-modal-actions .primary')?.textContent?.includes('Refresh order preview'))
  await page.click('.confirmation-modal .trade-modal-actions .primary')
  await page.waitForFunction(() => document.querySelector('.confirmation-modal .trade-modal-actions .primary')?.textContent?.includes('Confirm SHORT'))
  const protectionConfirmation = await page.$eval('.confirmation-protection', (element) => element.textContent?.replace(/\s+/g, ' ').trim())
  await page.screenshot({ path: '/tmp/antytilt-order-confirmation.png', fullPage: true })
  await page.click('.confirmation-modal .trade-modal-actions .primary')
  await page.waitForFunction(() => !document.querySelector('.confirmation-modal'))
  await page.waitForFunction(() => (
    document.querySelectorAll('.trade-protection-line.order-draft').length === 0
    && [...document.querySelectorAll('.trade-protection-line:not(.order-draft) strong')]
      .some((label) => label.textContent?.includes('ACTIVE SL · SHORT'))
  ))
  const protectionHandoff = await page.evaluate(() => ({
    drafts: document.querySelectorAll('.trade-protection-line.order-draft').length,
    activeShortStops: [...document.querySelectorAll('.trade-protection-line:not(.order-draft) strong')]
      .filter((label) => label.textContent?.includes('ACTIVE SL · SHORT')).length,
  }))

  await page.click('.bottom-tabs > button:nth-child(3)')
  await page.waitForSelector('.order-history-table:not(.history-head)')
  const orderHistoryText = await page.$eval('.order-history-table:not(.history-head)', (element) => element.textContent)
  await page.click('.bottom-tabs > button:nth-child(4)')
  await page.waitForSelector('.trade-history-table:not(.history-head)')
  const tradeHistoryText = await page.$eval('.trade-history-table:not(.history-head)', (element) => element.textContent)
  await page.click('.bottom-tabs > button:nth-child(5)')
  await page.waitForSelector('.assets-view')
  const assetsText = await page.$eval('.assets-view', (element) => element.textContent)
  await page.screenshot({ path: '/tmp/antytilt-account-data.png', fullPage: true })

  await page.click('.bottom-tabs > button:nth-child(2)')
  await page.waitForSelector('.orders-table:not(.orders-head)')
  await page.click('.order-row-actions button:first-child')
  await page.waitForSelector('.amend-order-modal')
  const amendHasTypedConfirmation = await page.$('.amend-order-modal .confirmation-field') !== null
  await page.$eval('.amend-order-modal .exchange-field input', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '0.02')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.click('.amend-order-modal .confirm-close-position')
  await page.waitForFunction(() => !document.querySelector('.amend-order-modal'))
  await page.click('.order-row-actions button:last-child')
  await page.waitForSelector('.cancel-order-modal')
  const cancelHasTypedConfirmation = await page.$('.cancel-order-modal .confirmation-field') !== null
  await page.click('.cancel-order-modal .confirm-close-position')
  await page.waitForFunction(() => !document.querySelector('.cancel-order-modal'))

  await page.click('.bottom-tabs > button:first-child')
  await page.click('.positions-table:not(.positions-head) > button')
  await page.waitForSelector('.position-close-modal')
  const closeHasTypedConfirmation = await page.$('.position-close-modal .confirmation-field') !== null
  await page.$eval('.close-percentage-control > input', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '37')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const closeSlider = await page.evaluate(() => ({
    percentage: document.querySelector('.close-size-heading strong')?.textContent,
    quantity: document.querySelector('.close-quantity-field input')?.value,
    labels: [...document.querySelectorAll('.close-range-labels button')].map((button) => button.textContent),
    hasLiveInstruction: document.querySelector('.position-close-modal')?.textContent?.includes('LIVE action'),
  }))
  const readCloseDialogTheme = () => page.evaluate(() => {
    const colors = (selector) => {
      const style = getComputedStyle(document.querySelector(selector))
      return { color: style.color, background: style.backgroundColor, border: style.borderColor, backgroundImage: style.backgroundImage }
    }
    return {
      theme: document.documentElement.dataset.theme,
      modal: colors('.position-close-modal'),
      title: colors('.position-close-modal > header strong'),
      subtitle: colors('.position-close-modal > header small'),
      summary: colors('.close-position-summary'),
      summaryCell: colors('.close-position-summary span'),
      summaryValue: colors('.close-position-summary strong'),
      quantity: colors('.close-quantity-field'),
      quantityInput: colors('.close-quantity-field input'),
      range: colors('.close-percentage-control > input'),
      point: colors('.close-range-points button:not(.active)'),
      execution: colors('.close-execution-row'),
      executionValue: colors('.close-execution-row strong'),
      confirm: colors('.confirm-close-position'),
    }
  })
  const closeDialogDark = await readCloseDialogTheme()
  await page.screenshot({ path: '/tmp/antytilt-close-position-modal-dark.png', fullPage: true })
  await page.$eval('.app-header .theme-toggle', (button) => button.click())
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  const closeDialogLight = await readCloseDialogTheme()
  await page.screenshot({ path: '/tmp/antytilt-close-position-modal-light.png', fullPage: true })
  await page.$eval('.app-header .theme-toggle', (button) => button.click())
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await page.click('.confirm-close-position')
  await page.waitForFunction(() => !document.querySelector('.position-close-modal'))

  const ui = await page.evaluate(() => ({
    marketDataLabel: document.querySelector('.connection-pill')?.textContent?.replace(/\s+/g, ' ').trim(),
    marketDataAria: document.querySelector('.connection-pill')?.getAttribute('aria-label'),
    connectedLabel: document.querySelector('.connect-button')?.textContent?.replace(/\s+/g, ' ').trim(),
    connectedAria: document.querySelector('.connect-button')?.getAttribute('aria-label'),
    connectedClass: document.querySelector('.connect-button')?.className,
    margin: document.querySelector('.order-topline button:first-child')?.textContent?.trim(),
    leverage: document.querySelector('.leverage-button')?.textContent?.trim(),
    executionNote: document.querySelector('.execution-note')?.textContent,
    riskStatus: document.querySelector('.pretrade-risk-status')?.textContent?.replace(/\s+/g, ' ').trim(),
    instrumentPriceTone: document.querySelector('.instrument-price strong')?.className,
    orderBookPriceTone: document.querySelector('.mid-price strong')?.className,
  }))
  const typography = await page.evaluate(() => {
    const px = (selector) => Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)
    return {
      navigation: px('.main-nav button'),
      instrument: px('.instrument-name'),
      primaryPrice: px('.instrument-price strong'),
      panelTab: px('.panel-tab'),
      bookRow: px('.book-row'),
      tradeRow: px('.trade-row'),
      orderControl: px('.advanced-order-panel .order-types button'),
      bottomRow: px('.positions-table:not(.positions-head)'),
    }
  })
  const orderBookLayout = await page.evaluate(() => {
    const panel = document.querySelector('.orderbook-panel')?.getBoundingClientRect()
    const marketColumn = document.querySelector('.market-column')?.getBoundingClientRect()
    const trades = document.querySelector('.trades-panel')?.getBoundingClientRect()
    const bidRows = [...document.querySelectorAll('.book-side.bid .book-row')]
    const askRows = [...document.querySelectorAll('.book-side.ask .book-row')]
    const lastBid = bidRows.at(-1)?.getBoundingClientRect()
    return {
      askRows: askRows.length,
      bidRows: bidRows.length,
      trailingGap: panel && lastBid ? Math.round(panel.bottom - lastBid.bottom) : null,
      sectionsGap: panel && trades ? Math.round(trades.top - panel.bottom) : null,
      fillsColumn: panel && trades && marketColumn ? Math.abs(marketColumn.height - (panel.height + trades.height + 1)) < 2 : false,
    }
  })
  riskRuntime = {
    active: true,
    enforcing: true,
    blocked: true,
    blockCode: 'MAX_TRADES_PER_DAY',
    blockRule: 'maxTradesPerDay',
    blockReason: 'RM system blocked new entries: the daily limit of 3 trades has been reached.',
    blockDetails: { used: 3, reserved: 0, limit: 3, resetAt: Date.now() + 60 * 60 * 1000, timeZone: 'Europe/Warsaw' },
    nextResetAt: Date.now() + 60 * 60 * 1000,
    workerStatus: 'RUNNING',
    lastCheckedAt: Date.now(),
  }
  await page.waitForFunction(() => document.querySelector('.pretrade-risk-status')?.textContent?.includes('Daily trade limit reached'), { timeout: 8_000 })
  await page.screenshot({ path: '/tmp/antytilt-risk-blocked-state.png', fullPage: true })
  const blockedUi = await page.evaluate(() => ({
    cta: document.querySelector('.place-order')?.textContent,
    disabled: document.querySelector('.place-order')?.disabled,
    reason: document.querySelector('.pretrade-risk-status')?.textContent?.replace(/\s+/g, ' ').trim(),
    reviewRules: document.querySelector('.pretrade-risk-status button')?.textContent,
  }))
  session.environment = 'prod-vst'
  accounts[0].environment = 'prod-vst'
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('.connect-button')?.textContent?.includes('BingX VST'))
  const vstConnection = await page.evaluate(() => {
    const button = document.querySelector('.connect-button')
    return {
      label: button?.textContent?.replace(/\s+/g, ' ').trim(),
      aria: button?.getAttribute('aria-label'),
      className: button?.className,
      color: button ? getComputedStyle(button).color : null,
      icon: button?.querySelector('svg')?.getAttribute('class'),
    }
  })
  const passed = captured.margin?.marginType === 'ISOLATED'
    && captured.margin?.confirmation === 'CONFIRM'
    && executableCatalog.count === 2
    && executableCatalog.subtitle?.includes('available on BingX')
    && executableCatalog.bingxBadges === 2
    && executableCatalog.logos === executableCatalog.count
    && executableCatalog.loadedLogos === executableCatalog.count
    && executableCatalog.fallbackLogos === 0
    && executableCatalog.selectedLogoLoaded
    && captured.leverage?.leverage === 35
    && captured.leverage?.confirmation === 'CONFIRM'
    && leverageMarkers.every((marker) => Math.abs(marker.left - ((marker.value - 1) / (leverageMarkers.at(-1).value - 1) * 100)) < 0.1)
    && !leverageCopy?.includes('Enter an order size')
    && selectedPercent === '38%'
    && redesignedOrderEntry.presets.join(',') === '25%,50%,75%,Max'
    && redesignedOrderEntry.hasDuplicatePercentageInput === false
    && redesignedOrderEntry.hasRangeMarkers === false
    && redesignedOrderEntry.protectionCards === 2
    && redesignedOrderEntry.summaryColumns === 3
    && redesignedOrderEntry.riskStatus?.includes('4 enabled rules')
    && chartProtectionPnl.draft.length === 2
    && chartProtectionPnl.draft.every((line) => Number.isFinite(line.top) && line.text?.includes('USDT') && line.text?.startsWith('DRAFT') && line.text?.includes('|'))
    && chartProtectionPnl.draft.find((line) => line.type === 'TP')?.text?.includes('|+')
    && chartProtectionPnl.draft.find((line) => line.type === 'SL')?.text?.includes('|−')
    && chartProtectionPnl.draft.every((line) => line.text?.includes('SHORT'))
    && chartProtectionPnl.existing.every((line) => line?.includes('ACTIVE') && line?.includes('|'))
    && sameSideDraftSuppressed
    && sameSideDraftStillSuppressed
    && zeroQuantityDraftHidden
    && ctaBeforeAmount.text === 'Enter an amount'
    && ctaBeforeAmount.disabled === true
    && captured.preview?.orderKind === 'MARKET'
    && captured.preview?.direction === 'SHORT'
    && captured.preview?.amountMode === 'VALUE'
    && captured.preview?.amount === 100
    && captured.preview?.takeProfit?.workingType === 'MARK_PRICE'
    && captured.preview?.stopLoss?.workingType === 'MARK_PRICE'
    && previewRequests === 2
    && protectionConfirmation?.includes('Take Profit')
    && protectionConfirmation?.includes('Stop Loss')
    && protectionConfirmation?.includes('R/R 1:2.00')
    && captured.execute?.previewId === 'preview-for-connected-ui-smoke-test-2'
    && captured.execute?.confirmation === 'CONFIRM'
    && protectionHandoff.drafts === 0
    && protectionHandoff.activeShortStops === 1
    && orderHistoryText?.includes('7001')
    && orderHistoryText?.includes('FILLED')
    && tradeHistoryText?.includes('8001')
    && tradeHistoryText?.includes('3.50 USDT')
    && assetsText?.includes('Available margin')
    && assetsText?.includes('700.00 USDT')
    && captured.amend?.quantity === 0.02
    && captured.amend?.confirmation === 'CONFIRM'
    && captured.cancel?.symbol === 'BTC-USDT'
    && captured.cancel?.confirmation === 'CONFIRM'
    && captured.close?.quantity === 0.003
    && captured.close?.confirmation === 'CONFIRM'
    && captured.protection?.kind === 'STOP_LOSS'
    && captured.protection?.orderId === stopOrder.orderId
    && captured.protection?.confirmation === 'CONFIRM'
    && stopLine.color === 'rgb(246, 70, 93)'
    && stopLine.label?.startsWith('ACTIVE SL')
    && markerCollision.count === 3
    && markerCollision.minGap >= 26
    && markerCollision.connectors >= 2
    && markerCollision.tradeZ > markerCollision.drawingZ
    && markerCollision.compactStop?.startsWith('ACTIVE SL · LONG|')
    && markerCollision.tooltip?.includes('Trigger:')
    && markerCollision.tooltip?.includes('Estimated P&L:')
    && markerTooltipVisible
    && draggedStopLineLight.background === 'rgb(255, 248, 249)'
    && draggedStopLineLight.priceColor === 'rgb(201, 54, 76)'
    && draggedStopLineLight.label?.startsWith('ACTIVE SL')
    && closeSlider.percentage === '37%'
    && closeSlider.quantity === '0.003'
    && closeSlider.labels.join(',') === '0%,25%,50%,75%,100%'
    && !closeSlider.hasLiveInstruction
    && closeDialogDark.theme === 'dark'
    && closeDialogDark.modal.background === 'rgb(16, 20, 26)'
    && closeDialogDark.title.color === 'rgb(238, 240, 243)'
    && closeDialogDark.summaryCell.background === 'rgb(12, 16, 21)'
    && closeDialogDark.quantity.background === 'rgb(9, 13, 18)'
    && closeDialogDark.confirm.background === 'rgb(198, 56, 80)'
    && closeDialogLight.theme === 'light'
    && closeDialogLight.modal.background === 'rgb(255, 255, 255)'
    && closeDialogLight.title.color === 'rgb(23, 32, 43)'
    && closeDialogLight.summaryCell.background === 'rgb(247, 249, 251)'
    && closeDialogLight.summaryValue.color === 'rgb(23, 32, 43)'
    && closeDialogLight.quantity.background === 'rgb(255, 255, 255)'
    && closeDialogLight.quantityInput.color === 'rgb(23, 32, 43)'
    && closeDialogLight.range.backgroundImage.includes('rgb(203, 211, 221)')
    && closeDialogLight.executionValue.color === 'rgb(37, 49, 65)'
    && closeDialogLight.confirm.background === 'rgb(217, 67, 87)'
    && !marginHasTypedConfirmation
    && !leverageHasTypedConfirmation
    && !orderHasTypedConfirmation
    && !amendHasTypedConfirmation
    && !cancelHasTypedConfirmation
    && !closeHasTypedConfirmation
    && ui.margin?.includes('Isolated')
    && ui.marketDataLabel === 'Market data: Binance Live'
    && ui.marketDataAria === 'Market data: Binance Live'
    && ui.connectedLabel === 'Trading account: BingX Live'
    && ui.connectedAria === 'Trading account: BingX Live'
    && ui.connectedClass?.includes('live-account')
    && ui.leverage?.includes('20x')
    && ui.executionNote?.includes('BingX Market')
    && ui.riskStatus?.includes('Risk Guard active')
    && ui.instrumentPriceTone === ui.orderBookPriceTone
    && typography.navigation >= 13
    && typography.instrument >= 17
    && typography.primaryPrice >= 20
    && typography.panelTab >= 12
    && typography.bookRow >= 11
    && typography.tradeRow >= 11
    && typography.orderControl >= 12
    && typography.bottomRow >= 11
    && themeSwitch.light.theme === 'light'
    && themeSwitch.light.storedTheme === 'light'
    && themeSwitch.light.body === 'rgb(242, 244, 247)'
    && themeSwitch.light.chart === 'rgb(255, 255, 255)'
    && themeSwitch.light.orderPanel === 'rgb(255, 255, 255)'
    && themeSwitch.light.text === 'rgb(23, 32, 43)'
    && themeSwitch.light.positionsHead === 'rgb(244, 246, 248)'
    && themeSwitch.light.positionsRow === 'rgb(255, 255, 255)'
    && themeSwitch.light.bottomAction === 'rgb(245, 247, 250)'
    && measureGesture.text?.includes('%')
    && measureGesture.text?.includes('bar')
    && measureGesture.text?.includes('→')
    && measureGesture.previewRemaining === false
    && measureGesture.anchors === 2
    && measureGesture.diagonal
    && measureGesture.connector
    && measureGesture.propertyRows === 2
    && measureGesture.cardInsidePlot
    && protectionDialogLight.modal.background === 'rgb(255, 255, 255)'
    && protectionDialogLight.title.color === 'rgb(23, 32, 43)'
    && protectionDialogLight.summary.background === 'rgb(255, 255, 255)'
    && protectionDialogLight.input.background === 'rgb(255, 255, 255)'
    && protectionDialogLight.select.background === 'rgb(255, 255, 255)'
    && protectionDialogLight.note.background === 'rgb(245, 247, 250)'
    && protectionDialogLight.cancel.background === 'rgb(245, 247, 250)'
    && protectionDialogLight.confirm.background === 'rgb(217, 67, 87)'
    && marketSelectorLight.modal.background === 'rgb(255, 255, 255)'
    && marketSelectorLight.title.color === 'rgb(23, 32, 43)'
    && marketSelectorLight.search.background === 'rgb(245, 247, 250)'
    && marketSelectorLight.listHead.background === 'rgb(244, 246, 248)'
    && marketSelectorLight.selectedRow.background === 'rgb(255, 249, 233)'
    && marketSelectorLight.footer.background === 'rgb(247, 249, 251)'
    && triggerLightControls.label === 'Trigger by'
    && triggerLightControls.options.join(',') === 'Last,Mark,Index'
    && triggerLightControls.source.background === 'rgb(255, 255, 255)'
    && triggerLightControls.source.color === 'rgb(37, 49, 65)'
    && triggerLightControls.priceInput.background === 'rgb(255, 255, 255)'
    && triggerLightControls.executionTrack.background === 'rgb(238, 242, 246)'
    && triggerLightControls.activeExecution.background === 'rgb(255, 255, 255)'
    && protectionLightControls.label === 'Trigger by'
    && protectionLightControls.source.background === 'rgb(255, 255, 255)'
    && protectionLightControls.source.color === 'rgb(37, 49, 65)'
    && protectionLightControls.modeTrack.background === 'rgb(238, 242, 246)'
    && protectionLightControls.activeMode.background === 'rgb(255, 255, 255)'
    && protectionLightControls.executionTrack.background === 'rgb(238, 242, 246)'
    && protectionLightControls.activeExecution.background === 'rgb(255, 255, 255)'
    && protectionLightControls.advancedPanel.background === 'rgb(255, 255, 255)'
    && marginLightDialog.title.color === 'rgb(23, 32, 43)'
    && marginLightDialog.selectedCard.background === 'rgb(255, 249, 236)'
    && marginLightDialog.defaultCard.background === 'rgb(248, 250, 252)'
    && marginLightDialog.info.background === 'rgb(246, 248, 251)'
    && marginLightDialog.cancel.background === 'rgb(247, 249, 251)'
    && marginLightDialog.disabledConfirm.background === 'rgb(247, 228, 181)'
    && leverageLightDialog.title.color === 'rgb(23, 32, 43)'
    && leverageLightDialog.stepButton.background === 'rgb(243, 246, 249)'
    && leverageLightDialog.input.background === 'rgb(255, 255, 255)'
    && leverageLightDialog.value.color === 'rgb(23, 32, 43)'
    && leverageLightDialog.cancel.background === 'rgb(247, 249, 251)'
    && leverageLightDialog.confirm.background === 'rgb(232, 170, 31)'
    && themeSwitch.maxLayoutShift <= 0.5
    && themeSwitch.restoredTheme === 'dark'
    && themeSwitch.storedTheme === 'dark'
    && terminalGeometry.maxOrderTypeShift <= 0.5
    && protectionGeometry.maxExecutionShift <= 0.5
    && orderBookLayout.askRows > 9
    && orderBookLayout.bidRows > 9
    && orderBookLayout.trailingGap !== null
    && orderBookLayout.trailingGap <= 2
    && orderBookLayout.sectionsGap === 1
    && orderBookLayout.fillsColumn
    && blockedUi.cta === 'Blocked by Risk Guard'
    && blockedUi.disabled === true
    && blockedUi.reason?.includes('3/3')
    && blockedUi.reason?.includes('Resets in')
    && blockedUi.reviewRules === 'Review rules'
    && vstConnection.label === 'Trading account: BingX VST'
    && vstConnection.aria === 'Trading account: BingX VST'
    && vstConnection.className?.includes('vst-account')
    && vstConnection.color === 'rgb(125, 181, 245)'
    && Boolean(vstConnection.icon)
    && errors.length === 0

  console.log(JSON.stringify({ passed, captured, executableCatalog, leverageMarkers, closeSlider, closeDialogDark, closeDialogLight, previewRequests, protectionConfirmation, selectedPercent, redesignedOrderEntry, chartProtectionPnl, sameSideDraftSuppressed, sameSideDraftStillSuppressed, zeroQuantityDraftHidden, protectionHandoff, markerCollision, markerTooltipVisible, draggedStopLineLight, ctaBeforeAmount, blockedUi, vstConnection, orderBookLayout, themeSwitch, measureGesture, triggerLightControls, protectionLightControls, protectionDialogLight, marketSelectorLight, marginLightDialog, leverageLightDialog, terminalGeometry, protectionGeometry, typography, typedConfirmationFields: { marginHasTypedConfirmation, leverageHasTypedConfirmation, orderHasTypedConfirmation, amendHasTypedConfirmation, cancelHasTypedConfirmation, closeHasTypedConfirmation }, ui, errors }, null, 2))
  if (!passed) process.exitCode = 1
} finally {
  await browser.close()
}
