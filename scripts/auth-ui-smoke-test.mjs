import puppeteer from 'puppeteer-core'

const appPort = process.argv[2] || '5173'
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  const pageErrors = []
  let submittedCredentials
  let loginSucceeds = false
  let restoredSession = false

  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/auth/session') {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(restoredSession
          ? { authenticated: true, user: { id: 'auth-ui-user', email: 'autofill@example.com', createdAt: Date.now() } }
          : { authenticated: false }),
      })
      return
    }
    if (url.pathname === '/api/auth/login') {
      submittedCredentials = JSON.parse(request.postData() || '{}')
      void request.respond({
        status: loginSucceeds ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify(loginSucceeds
          ? { authenticated: true, user: { id: 'auth-ui-user', email: 'autofill@example.com', createdAt: Date.now() } }
          : { error: 'Synthetic login response' }),
      })
      return
    }
    if (url.pathname === '/api/auth/logout') {
      restoredSession = false
      void request.respond({ status: 204 })
      return
    }
    void request.continue()
  })

  await page.goto(`http://127.0.0.1:${appPort}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.auth-card input[name="password"]')
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== 'light') {
    await page.click('.auth-theme-toggle')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  }
  await new Promise((resolve) => setTimeout(resolve, 360))
  const lightTheme = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    storedTheme: localStorage.getItem('antytilt:theme'),
    shell: getComputedStyle(document.querySelector('.auth-shell')).backgroundColor,
    card: getComputedStyle(document.querySelector('.auth-card')).backgroundColor,
    input: getComputedStyle(document.querySelector('.auth-card input')).backgroundColor,
  }))
  await page.screenshot({ path: '/tmp/antytilt-auth-light-theme.png', fullPage: true })

  const buttonEnabledBeforeInput = await page.$eval('.auth-submit', (button) => !button.disabled)
  await page.evaluate(() => {
    // Password managers can update native input values without dispatching React events.
    document.querySelector('input[name="email"]').value = 'autofill@example.com'
    document.querySelector('input[name="password"]').value = 'browser-filled-password'
  })
  await page.click('.auth-submit')

  const timeoutAt = Date.now() + 3_000
  while (!submittedCredentials && Date.now() < timeoutAt) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  await page.waitForSelector('.auth-error')
  const animationAfterError = await page.$('.login-market-pulse') !== null

  loginSucceeds = true
  await page.click('.auth-submit')
  await page.waitForSelector('.login-market-pulse')
  await page.waitForSelector('.app-header')
  const transitionStartedAt = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 520))
  const marketPulse = await page.evaluate(() => ({
    label: document.querySelector('.login-market-pulse')?.getAttribute('aria-label'),
    wordmark: document.querySelector('.market-pulse-wordmark')?.textContent,
    traceAnimation: getComputedStyle(document.querySelector('.market-pulse-trace path')).animationName,
    markAnimation: getComputedStyle(document.querySelector('.market-pulse-mark')).animationName,
    wordmarkAnimation: getComputedStyle(document.querySelector('.market-pulse-wordmark')).animationName,
    terminalMountedBehind: Boolean(document.querySelector('.app-header')),
    theme: document.documentElement.dataset.theme,
    background: getComputedStyle(document.querySelector('.login-market-pulse')).backgroundColor,
    viewportCovered: (() => {
      const rect = document.querySelector('.login-market-pulse')?.getBoundingClientRect()
      return Boolean(rect && rect.left <= 0 && rect.top <= 0 && rect.right >= innerWidth && rect.bottom >= innerHeight)
    })(),
  }))
  await page.screenshot({ path: '/tmp/antytilt-market-pulse-light.png', fullPage: true })
  await page.waitForFunction(() => !document.querySelector('.login-market-pulse'), { timeout: 3_000 })
  const transitionDuration = Date.now() - transitionStartedAt

  restoredSession = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-header')
  await new Promise((resolve) => setTimeout(resolve, 120))
  const animationAfterSessionRestore = await page.$('.login-market-pulse') !== null

  await page.click('[aria-label="Sign out"]')
  await page.waitForSelector('.auth-card')
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== 'dark') {
    await page.click('.auth-theme-toggle')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  }
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.type('input[name="email"]', 'autofill@example.com')
  await page.type('input[name="password"]', 'browser-filled-password')
  const reducedStartedAt = Date.now()
  await page.click('.auth-submit')
  await page.waitForSelector('.login-market-pulse')
  const reducedMotion = await page.evaluate(() => ({
    overlayAnimation: getComputedStyle(document.querySelector('.login-market-pulse')).animationName,
    stageAnimation: getComputedStyle(document.querySelector('.market-pulse-stage')).animationName,
    traceDisplay: getComputedStyle(document.querySelector('.market-pulse-trace')).display,
    background: getComputedStyle(document.querySelector('.login-market-pulse')).backgroundColor,
  }))
  await page.waitForFunction(() => !document.querySelector('.login-market-pulse'), { timeout: 1_000 })
  const reducedDuration = Date.now() - reducedStartedAt

  const passed = buttonEnabledBeforeInput
    && lightTheme.theme === 'light'
    && lightTheme.storedTheme === 'light'
    && lightTheme.shell === 'rgb(242, 244, 247)'
    && lightTheme.card === 'rgba(255, 255, 255, 0.96)'
    && lightTheme.input === 'rgb(255, 255, 255)'
    && submittedCredentials?.email === 'autofill@example.com'
    && submittedCredentials?.password === 'browser-filled-password'
    && animationAfterError === false
    && marketPulse.label === 'Opening the AntyTILT trading terminal'
    && marketPulse.wordmark === 'ANTYTILT'
    && marketPulse.traceAnimation.includes('market-pulse-trace-draw')
    && marketPulse.markAnimation === 'market-pulse-mark-draw'
    && marketPulse.wordmarkAnimation === 'market-pulse-word-reveal'
    && marketPulse.terminalMountedBehind
    && marketPulse.theme === 'light'
    && marketPulse.background === 'rgb(244, 246, 248)'
    && marketPulse.viewportCovered
    && transitionDuration >= 1_750
    && transitionDuration < 2_600
    && animationAfterSessionRestore === false
    && reducedMotion.overlayAnimation === 'market-pulse-reduced'
    && reducedMotion.stageAnimation === 'none'
    && reducedMotion.traceDisplay === 'none'
    && reducedMotion.background === 'rgb(8, 10, 13)'
    && reducedDuration < 700
    && pageErrors.length === 0

  console.log(JSON.stringify({
    passed,
    buttonEnabledBeforeInput,
    lightTheme,
    submittedEmail: submittedCredentials?.email,
    passwordCaptured: submittedCredentials?.password === 'browser-filled-password',
    animationAfterError,
    marketPulse,
    transitionDuration,
    animationAfterSessionRestore,
    reducedMotion,
    reducedDuration,
    pageErrors,
  }, null, 2))
  if (!passed) process.exitCode = 1
} finally {
  await browser.close()
}
