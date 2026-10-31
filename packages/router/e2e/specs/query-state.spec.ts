import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-01-02T00:00:00Z'))
  await page.goto('/query-state/')
  await expect(page.getByRole('textbox', { name: 'Search' })).toBeVisible()
})

test('shares immediate state and settles independently scheduled patch keys', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Split patch' }).click()
  await expect(page.locator('#state')).toHaveText('split')
  await expect(page.locator('#page')).toHaveText('3')
  await expect(page.locator('#result')).toHaveText('waiting')
  await expect(page.locator('#pending')).toHaveText('true')
  await page.clock.runFor(250)
  await expect(page.locator('#result')).toHaveText('success')
  await expect(page).toHaveURL('/query-state/?p=3&q=split')
  await expect(page.locator('#pending')).toHaveText('false')
})

test('resets explicit defaults and removes them independently of clearOnDefault', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.locator('#result')).toHaveText('success')
  await expect(page).toHaveURL('/query-state/?q=&p=1')
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.locator('#result')).toHaveText('waiting')
  await page.clock.runFor(320)
  await expect(page.locator('#result')).toHaveText('success')
  await expect(page).toHaveURL('/query-state/')
})

test('cancels queued edits on external navigation even when a guard blocks it', async ({
  page,
}) => {
  await page.getByRole('textbox', { name: 'Search' }).fill('draft')
  await expect(page.locator('#pending')).toHaveText('true')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'External', exact: true }).click()
  await expect(page.locator('#pending')).toHaveText('false')
  await expect(page.locator('#state')).toHaveText('')
  await page.clock.runFor(1000)
  await expect(page).toHaveURL('/query-state/')
})

test('native Back and Forward cancel delayed writes instead of restoring them later', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page).toHaveURL('/query-state/?q=next')
  await page.getByRole('textbox', { name: 'Search' }).fill('back-draft')
  await page.evaluate(() => history.back())
  await expect(page).toHaveURL('/query-state/')
  await expect(page.locator('#pending')).toHaveText('false')
  await expect(page.locator('#state')).toHaveText('')
  await page.clock.runFor(1000)
  await expect(page).toHaveURL('/query-state/')
  await page.getByRole('textbox', { name: 'Search' }).fill('forward-draft')
  await page.evaluate(() => history.forward())
  await expect(page).toHaveURL('/query-state/?q=next')
  await expect(page.locator('#pending')).toHaveText('false')
  await page.clock.runFor(1000)
  await expect(page.locator('#state')).toHaveText('next')
  await expect(page).toHaveURL('/query-state/?q=next')
})

test('blocked native Back cancels debounce and restores the history entry', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page).toHaveURL('/query-state/?q=next')
  await page.getByRole('textbox', { name: 'Search' }).fill('draft')
  await page.getByRole('checkbox').check()
  const visits = Number(await page.locator('#visits').textContent())
  await page.evaluate(() => history.back())
  await expect(page.locator('#visits')).toHaveText(String(visits + 1))
  await expect(page).toHaveURL('/query-state/?q=next')
  await expect(page.locator('#pending')).toHaveText('false')
  await page.clock.runFor(1000)
  await expect(page.locator('#state')).toHaveText('next')
})

for (const kind of ['Sync', 'Async']) {
  test(`${kind} child navigation settles without a first-await restriction`, async ({
    page,
  }) => {
    await page
      .getByRole('button', { name: `${kind} child`, exact: true })
      .click()
    await expect(page).toHaveURL('/query-state/other')
    await expect(page.locator('#result')).toHaveText('failure')
    await expect(page.locator('#pending')).toHaveText('false')
  })
}

test('immediate replacements still wait for the shared safety interval', async ({
  page,
}) => {
  const input = page.getByRole('textbox', { name: 'Search' })
  await input.fill('first')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.locator('#result')).toHaveText('success')
  await expect(page).toHaveURL('/query-state/?q=first')
  await input.fill('second')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.locator('#state')).toHaveText('second')
  await page.clock.runFor(49)
  await expect(page).toHaveURL('/query-state/?q=first')
  await expect(page.locator('#result')).toHaveText('waiting')
  await page.clock.runFor(271)
  await expect(page).toHaveURL('/query-state/?q=second')
  await expect(page.locator('#result')).toHaveText('success')
})
