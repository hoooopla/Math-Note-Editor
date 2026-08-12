const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const warnings = [];
  page.on('console', msg => {
    if (msg.type() === 'warning') warnings.push(msg.text());
  });
  await page.goto('http://localhost:3000');
  await page.waitForTimeout(3000);
  console.log("WARNINGS_FOUND:", warnings);
  await browser.close();
})();
