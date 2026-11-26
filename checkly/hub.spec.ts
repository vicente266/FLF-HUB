import { test, expect } from '@playwright/test';

// A signed-out visitor: the app must start, Firebase must send them to the sign-in page, and
// nothing may throw on the way. Catches a broken build or config, not bugs behind sign-in.
test('Hub opens', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});

	await page.goto('https://hub.foundersforlifefellowship.com/');
	await expect(page).toHaveURL(/\/login/);
	await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
	expect(errors).toEqual([]);
});
