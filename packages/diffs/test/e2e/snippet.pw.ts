import { expect, type Page, test } from '@playwright/test';

// Space between the code column's edges and its first/last line row.
async function edgeGaps(page: Page, mount: string) {
  return page
    .locator(`[data-mount="${mount}"] [data-code]`)
    .evaluateAll((codes) =>
      codes.map((code) => {
        const box = code.getBoundingClientRect();
        const rows = [...code.querySelectorAll('[data-content] [data-line]')];
        const first = rows[0].getBoundingClientRect();
        const last = rows[rows.length - 1].getBoundingClientRect();
        return {
          top: Math.round(first.top - box.top),
          bottom: Math.round(box.bottom - last.bottom),
        };
      })
    );
}

for (const type of ['unified', 'split', 'file']) {
  test(`${type}: hidden boundary separators leave no gap`, async ({ page }) => {
    await page.goto(`/test/e2e/fixtures/snippet.html?type=${type}&hide`);
    const snippet = page.locator('[data-mount="snippet"] [data-code]').first();
    await expect(snippet.locator('[data-line]').first()).toBeVisible();
    await expect(
      page.locator('[data-mount="snippet"] [data-snippet-boundary]').first()
    ).toBeHidden();
    // A snippet whose edge folds are hidden sits in its frame exactly like a
    // full render of the same file.
    expect(await edgeGaps(page, 'snippet')).toEqual(
      await edgeGaps(page, 'full')
    );
  });

  test(`${type}: built-in boundary separators open on click`, async ({
    page,
  }) => {
    await page.goto(`/test/e2e/fixtures/snippet.html?type=${type}`);
    const mount = page.locator('[data-mount="snippet"]');
    const label = mount
      .locator(
        '[data-gutter] [data-snippet-boundary="below"] [data-unmodified-lines]'
      )
      .first();
    await expect(label).toBeVisible();
    await label.click();
    await expect(mount.locator('[data-snippet-boundary="below"]')).toHaveCount(
      0
    );
    await expect(
      mount.locator('[data-content] [data-line="60"]').first()
    ).toBeVisible();
  });
}
