import puppeteer from 'puppeteer-core'

const appPort = process.argv[2] || '5173'
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    const responses = {
      '/api/auth/session': { authenticated: true, user: { id: '00000000-0000-4000-8000-000000000001', email: 'ui-smoke@example.com', createdAt: Date.now() } },
      '/api/exchange/session': { connected: false, liveTradingEnabled: true, liveTriggerOrdersEnabled: false },
      '/api/exchange/accounts': { accounts: [] },
    }
    if (path in responses) {
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(responses[path]) })
      return
    }
    void request.continue()
  })
  await page.goto(`http://127.0.0.1:${appPort}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.connect-button')

  await page.click('.connect-button')
  await page.waitForSelector('.exchange-modal')
  const vst = await page.evaluate(() => ({
    title: document.querySelector('.exchange-modal-title')?.textContent,
    selectedEnvironment: document.querySelector('.environment-switch button.active')?.textContent,
    liveWarning: Boolean(document.querySelector('.live-warning')),
    secretType: document.querySelector('[aria-label="BingX Secret Key"]')?.getAttribute('type'),
  }))

  await page.click('.environment-switch button:nth-child(2)')
  const live = await page.evaluate(() => ({
    selectedEnvironment: document.querySelector('.environment-switch button.active')?.textContent,
    liveWarning: document.querySelector('.live-warning')?.textContent,
  }))

  await page.type('[aria-label="BingX API Key"]', 'fake-api-key-for-ui-test')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => 'fake-secret-key-for-ui-test' },
    })
  })
  await page.focus('[aria-label="BingX Secret Key"]')
  await page.click('.exchange-key-input.secret button:first-of-type')
  await page.waitForFunction(() => document.querySelector('.exchange-key-input.secret input')?.value === 'fake-secret-key-for-ui-test')
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  const secretFocusAfterPaste = await page.evaluate(() => document.activeElement === document.querySelector('.exchange-key-input.secret input'))
  await page.click('.exchange-key-input.secret button:last-child')
  const revealedSecretType = await page.$eval('.exchange-key-input.secret input', (input) => input.getAttribute('type'))
  const secretFocusAfterReveal = await page.evaluate(() => document.activeElement === document.querySelector('.exchange-key-input.secret input'))
  await page.click('.exchange-modal header > button')
  await page.waitForSelector('.market-source-switch')
  const chartSources = await page.$$eval('.market-source-switch button', (buttons) => buttons.map((button) => button.textContent?.trim()))
  await page.click('.market-source-switch button:nth-of-type(3)')
  await page.waitForFunction(() => document.querySelector('.market-source-switch button.active')?.textContent?.includes('Bybit'))
  const activeChartSource = await page.$eval('.market-source-switch button.active', (button) => button.textContent?.trim())
  const browserStorage = await page.evaluate(() => ({ ...localStorage }))
  const orderPanel = await page.$eval('.order-panel', (element) => element.textContent)
  await page.screenshot({ path: '/tmp/antytilt-bingx-ui.png', fullPage: true })

  const passed = vst.title?.includes('BingX API connection')
    && vst.selectedEnvironment?.includes('VST demo')
    && !vst.liveWarning
    && vst.secretType === 'password'
    && live.selectedEnvironment?.includes('Live account')
    && live.liveWarning?.includes('real funds')
    && secretFocusAfterPaste
    && revealedSecretType === 'text'
    && secretFocusAfterReveal
    && chartSources.length === 3
    && activeChartSource?.includes('Bybit')
    && Object.entries(browserStorage).some(([key, value]) => key.endsWith(':market-source') && value === 'bybit')
    && !Object.values(browserStorage).some((value) => String(value).includes('fake-'))
    && orderPanel?.includes('Connect BingX above')
    && pageErrors.length === 0

  console.log(JSON.stringify({ passed, vst, live, secretFocusAfterPaste, revealedSecretType, secretFocusAfterReveal, chartSources, activeChartSource, storageKeys: Object.keys(browserStorage), pageErrors }, null, 2))
  if (!passed) process.exitCode = 1
} finally {
  await browser.close()
}
