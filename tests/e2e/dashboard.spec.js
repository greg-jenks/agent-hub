const { test, expect } = require('@playwright/test');

test('dashboard initial load shows four idle cards and panels', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Agent Hub');
  await expect(page.locator('#card-planner')).toBeVisible();
  await expect(page.locator('#card-coder')).toBeVisible();
  await expect(page.locator('#card-reviewer')).toBeVisible();
  await expect(page.locator('#card-refactor')).toBeVisible();

  await expect(page.locator('#state-planner')).toContainText('Idle');
  await expect(page.locator('#state-coder')).toContainText('Idle');
  await expect(page.locator('#state-reviewer')).toContainText('Idle');
  await expect(page.locator('#state-refactor')).toContainText('Idle');

  await expect(page.locator('#feed')).toBeVisible();
  await expect(page.locator('#learningsFeed')).toBeVisible();
});

test('dashboard updates in real-time from status API', async ({ page, request }) => {
  await page.goto('/');

  await request.post('/status', { data: { agent: 'planner', state: 'active', message: 'Planning' } });
  await expect(page.locator('#card-planner')).toHaveClass(/state-active/);

  await request.post('/status', { data: { agent: 'coder', state: 'active', message: 'Coding' } });
  await expect(page.locator('#card-coder')).toHaveClass(/state-active/);

  await request.post('/status', { data: { agent: 'planner', state: 'done', message: 'Done' } });
  await expect(page.locator('#card-planner')).toHaveClass(/state-done/);

  await request.post('/status', { data: { agent: 'reviewer', state: 'attention', message: 'Need input' } });
  await expect(page.locator('#state-reviewer')).toContainText(/Attention/i);
  await expect(page.locator('#card-reviewer')).toHaveClass(/state-attention/);
  await expect(page).toHaveTitle(/Agent Hub/);

  await expect(page.locator('#feed')).toContainText('Need input');
});

test('copy command button writes to clipboard', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');

  await page.locator('#card-planner .launch-btn').click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('planner');
});
