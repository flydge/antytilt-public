import puppeteer from 'puppeteer-core'

const appPort = process.argv[2] || '5173'
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
})

const defaultProfile = {
  active: false,
  timezone: 'UTC',
  externalViolationPolicy: 'BLOCK_NEW_ENTRIES',
  breachAction: 'BLOCK_NEW_ENTRIES',
  closeExternalEntriesOnBreach: true,
  automationConsent: true,
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
  updatedAt: 0,
}

let capturedProfile = null

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) {
      request.continue()
      return
    }
    let body = {}
    if (url.pathname === '/api/auth/session') {
      body = { authenticated: true, user: { id: 'risk-ui-user', email: 'risk@example.com', createdAt: Date.now() } }
    } else if (url.pathname === '/api/exchange/session') {
      body = { connected: false, accounts: [], liveTradingEnabled: false, liveTriggerOrdersEnabled: false }
    } else if (url.pathname === '/api/exchange/accounts') {
      body = { accounts: [] }
    } else if (url.pathname === '/api/risk/profile' && request.method() === 'GET') {
      body = defaultProfile
    } else if (url.pathname === '/api/risk/profile' && request.method() === 'PUT') {
      capturedProfile = JSON.parse(request.postData())
      body = { ...capturedProfile, updatedAt: Date.now() }
    } else if (url.pathname === '/api/risk/status') {
      body = {
        workerStatus: 'RUNNING',
        lastCheckedAt: Date.now() - 3_000,
        tradesUsed: 1,
        tradeLimit: 6,
        tradesRemaining: 5,
        dailyPnl: -22.13,
        dailyOpeningEquity: 1_000,
        currentEquity: 977.87,
        openPositions: 1,
        nextResetAt: Date.now() + 6 * 60 * 60_000 + 42 * 60_000,
        managedProtections: 1,
        trackedProtections: 1,
        breakevenLatched: 0,
        liveAutomationEnabled: true,
      }
    } else if (url.pathname === '/api/risk/events') {
      body = {
        events: [
          { id: 'event-1', type: 'ORDER_BLOCKED', createdAt: Date.now() - 2_000, action: 'BLOCK_ORDER', outcome: 'BLOCKED', rule: 'riskPerTrade', message: 'Order blocked by the configured risk per trade limit.' },
          { id: 'event-2', type: 'POSITION_CLOSED', createdAt: Date.now() - 65_000, action: 'CLOSE_POSITION', outcome: 'SUCCEEDED', rule: 'maxTradesPerDay', message: 'Direct exchange bypass entry closed successfully.' },
        ],
      }
    }
    request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  const waitForCard = async (rule) => {
    await page.waitForSelector(`.rm3-rule-card[data-rule="${rule}"]`)
    await page.waitForFunction(() => document.querySelector('.rm3-carousel')?.getAttribute('aria-busy') === 'false')
  }

  await page.goto(`http://127.0.0.1:${appPort}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.rm-nav')
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== 'light') {
    await page.click('.app-header .theme-toggle')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  }
  await page.click('.rm-nav')
  await page.waitForSelector('.rm3-carousel')
  await new Promise((resolve) => setTimeout(resolve, 650))

  const initial = await page.evaluate(() => {
    const card = document.querySelector('.rm3-rule-card')
    const art = card?.querySelector('.rm3-card-art')
    const image = art?.querySelector('img')
    const artRect = art?.getBoundingClientRect()
    const imageRect = image?.getBoundingClientRect()
    return {
      title: document.querySelector('.rm3-title-block h1')?.textContent,
      activeRule: card?.getAttribute('data-rule'),
      previewCards: document.querySelectorAll('.rm3-preview-card').length,
      categories: document.querySelectorAll('.rm3-categories button').length,
      metrics: document.querySelectorAll('.rm3-metric').length,
      tabs: document.querySelectorAll('.rm3-tabs [role="tab"]').length,
      enabledCount: document.querySelector('.rm3-tabs [role="tab"] span')?.textContent?.trim(),
      policyText: document.querySelector('.rm3-policy-summary')?.textContent?.replace(/\s+/g, ' ').trim(),
      monitorText: document.querySelector('.rm3-monitor')?.textContent?.replace(/\s+/g, ' ').trim(),
      ruleEnabled: card?.querySelector('.rm3-rule-toggle')?.getAttribute('aria-pressed'),
      artwork: image?.getAttribute('src')?.split('/').at(-1),
      artworkObjectFit: image ? getComputedStyle(image).objectFit : null,
      artworkInside: Boolean(artRect && imageRect && imageRect.left >= artRect.left - 1 && imageRect.right <= artRect.right + 1 && imageRect.top >= artRect.top - 1 && imageRect.bottom <= artRect.bottom + 1),
      pageBackground: getComputedStyle(document.querySelector('.rm3-page')).backgroundColor,
      cardBackground: getComputedStyle(card).backgroundColor,
    }
  })

  await page.click('.rm3-guide-button')
  await page.waitForSelector('.rm3-guide-popover')
  const guide = await page.evaluate(() => {
    const popover = document.querySelector('.rm3-guide-popover')
    const rect = popover.getBoundingClientRect()
    return {
      title: popover.querySelector('header strong')?.textContent,
      details: popover.querySelectorAll('li').length,
      insideViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
    }
  })
  await page.screenshot({ path: '/tmp/antytilt-risk-management-carousel-light.png', fullPage: true })
  await page.click('.rm3-guide-popover header button')

  const beforeSwipe = await page.$eval('.rm3-rule-toggle', (element) => element.getAttribute('aria-pressed'))
  const swipeStart = await page.$eval('.rm3-card-art', (element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await page.mouse.move(swipeStart.x, swipeStart.y)
  await page.mouse.down()
  await page.mouse.move(swipeStart.x - 230, swipeStart.y, { steps: 10 })
  await page.mouse.up()
  await waitForCard('breakEven')
  const swipeAudit = await page.evaluate((previousEnabled) => ({
    activeRule: document.querySelector('.rm3-rule-card')?.getAttribute('data-rule'),
    newRuleEnabled: document.querySelector('.rm3-rule-toggle')?.getAttribute('aria-pressed'),
    previousEnabled,
    dirty: Boolean(document.querySelector('.rm3-savebar')),
  }), beforeSwipe)

  await page.click('.rm3-rule-toggle')
  await page.waitForSelector('.rm3-savebar')
  const toggleAudit = await page.evaluate(() => ({
    enabled: document.querySelector('.rm3-rule-toggle')?.getAttribute('aria-pressed'),
    saveLabel: document.querySelector('.rm3-savebar .primary')?.textContent?.replace(/\s+/g, ' ').trim(),
  }))

  await page.click('.rm3-policy-summary > button')
  await page.waitForSelector('.rm3-policy-drawer')
  await new Promise((resolve) => setTimeout(resolve, 320))
  const drawer = await page.evaluate(() => {
    const element = document.querySelector('.rm3-policy-drawer')
    const rect = element.getBoundingClientRect()
    return {
      title: element.querySelector('h2')?.textContent,
      subtitle: element.querySelector('header p')?.textContent,
      policies: element.querySelectorAll('[role="radio"]').length,
      checked: element.querySelector('[role="radio"][aria-checked="true"] strong')?.textContent,
      hasBypass: element.textContent.includes('Close bypass entries'),
      hasPermissions: element.textContent.includes('Allow automatic exchange actions'),
      rect: { top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: { width: innerWidth, height: innerHeight },
      insideViewport: rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
    }
  })
  await page.screenshot({ path: '/tmp/antytilt-risk-management-policy-light.png', fullPage: true })
  await page.click('.rm3-policy-drawer header button')
  await page.waitForFunction(() => !document.querySelector('.rm3-policy-drawer'))

  await page.$eval('.rm3-tabs [role="tab"]:nth-child(2)', (button) => button.click())
  await page.waitForFunction(() => document.querySelector('.rm3-tabs [role="tab"]:nth-child(2)')?.getAttribute('aria-selected') === 'true')
  await page.waitForSelector('.rm3-activity-table')
  const activity = await page.evaluate(() => ({
    rows: document.querySelectorAll('.rm3-activity-row').length,
    text: document.querySelector('.rm3-activity-table')?.textContent?.replace(/\s+/g, ' ').trim(),
  }))
  await page.click('.rm3-tabs [role="tab"]:first-child')
  await page.waitForSelector('.rm3-carousel')

  const responsive = []
  for (const width of [1280, 900, 600]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 })
    await new Promise((resolve) => setTimeout(resolve, 160))
    responsive.push(await page.evaluate((viewportWidth) => {
      const shell = document.querySelector('.rm3-shell').getBoundingClientRect()
      const card = document.querySelector('.rm3-rule-card').getBoundingClientRect()
      return {
        width: viewportWidth,
        shell: { left: shell.left, right: shell.right },
        card: { left: card.left, right: card.right },
        innerWidth,
        shellInside: shell.left >= -1 && shell.right <= innerWidth + 1,
        cardInside: card.left >= -1 && card.right <= innerWidth + 1,
        previewCardsVisible: [...document.querySelectorAll('.rm3-preview-card')].filter((element) => getComputedStyle(element).display !== 'none').length,
      }
    }, width))
  }

  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  await page.click('.rm3-savebar .primary')
  await page.waitForSelector('.rm3-toast')
  await new Promise((resolve) => setTimeout(resolve, 250))
  const saved = await page.evaluate(() => ({
    notice: document.querySelector('.rm3-toast')?.textContent?.replace(/\s+/g, ' ').trim(),
    active: Boolean(document.querySelector('.rm3-policy-active')),
    dirty: Boolean(document.querySelector('.rm3-savebar')),
  }))

  await page.click('.app-header .theme-toggle')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await new Promise((resolve) => setTimeout(resolve, 250))
  const dark = await page.evaluate(() => ({
    pageBackground: getComputedStyle(document.querySelector('.rm3-page')).backgroundColor,
    cardBackground: getComputedStyle(document.querySelector('.rm3-rule-card')).backgroundColor,
    headingColor: getComputedStyle(document.querySelector('.rm3-card-heading h2')).color,
  }))
  await page.screenshot({ path: '/tmp/antytilt-risk-management-carousel-dark.png', fullPage: true })

  const passed = initial.title === 'Risk Management'
    && initial.activeRule === 'fixedStopLoss'
    && initial.previewCards === 2
    && initial.categories === 5
    && initial.metrics === 4
    && initial.tabs === 2
    && initial.enabledCount === '4 / 10'
    && initial.policyText?.includes('Applies to all 10 rules')
    && initial.policyText?.includes('Block new entries')
    && initial.monitorText?.startsWith('Monitoring active')
    && initial.ruleEnabled === 'false'
    && initial.artwork === 'protective-stop.png'
    && initial.artworkObjectFit === 'contain'
    && initial.artworkInside
    && guide.title === 'Protective Stop Loss'
    && guide.details === 3
    && guide.insideViewport
    && swipeAudit.activeRule === 'breakEven'
    && swipeAudit.previousEnabled === 'false'
    && swipeAudit.newRuleEnabled === 'false'
    && swipeAudit.dirty === false
    && toggleAudit.enabled === 'true'
    && toggleAudit.saveLabel === 'Save & activate'
    && drawer.title === 'Account policy'
    && drawer.subtitle === 'Applies to all 10 rules'
    && drawer.policies === 4
    && drawer.checked === 'Block new entries'
    && drawer.hasBypass
    && drawer.hasPermissions
    && drawer.insideViewport
    && activity.rows === 2
    && activity.text?.includes('Entry blocked')
    && activity.text?.includes('Position closed')
    && responsive.every((audit) => audit.shellInside && audit.cardInside)
    && responsive.find((audit) => audit.width === 1280)?.previewCardsVisible === 2
    && responsive.find((audit) => audit.width === 900)?.previewCardsVisible === 0
    && responsive.find((audit) => audit.width === 600)?.previewCardsVisible === 0
    && capturedProfile?.active === true
    && capturedProfile?.breakEven?.enabled === true
    && saved.notice === 'Risk profile saved and active'
    && saved.active
    && saved.dirty === false
    && dark.pageBackground === 'rgb(11, 16, 22)'
    && dark.cardBackground === 'rgb(16, 22, 29)'
    && pageErrors.length === 0

  console.log(JSON.stringify({
    passed,
    initial,
    guide,
    swipeAudit,
    toggleAudit,
    drawer,
    activity,
    responsive,
    saved,
    dark,
    capturedProfile,
    pageErrors,
    screenshots: [
      '/tmp/antytilt-risk-management-carousel-light.png',
      '/tmp/antytilt-risk-management-policy-light.png',
      '/tmp/antytilt-risk-management-carousel-dark.png',
    ],
  }, null, 2))
  if (!passed) process.exitCode = 1
} finally {
  await browser.close()
}
