import { expect, test } from '@playwright/test'

import '../envConfig'

// The rules a person actually meets.
//
// `type="tel"` has never validated anything in any browser, and `type="email"` only fires on a
// native form submit — which several of these forms do not do. So both were decorative, and a
// phone field accepted "hello".

// Exercised on the booking form, which is always present. The public training signup uses the
// same two components, so it is the components under test rather than one page's wiring.
test.use({ storageState: 'e2e/.auth/provider.json' })

test.describe('what a field will accept', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'behaviour, covered once')

  test('letters never reach a phone field, and it formats as you type', async ({ page }, info) => {
    test.skip(info.project.name === 'phone', 'covered once, on desktop')

    await page.goto('/app/book')

    const phone = page.getByLabel('Phone')
    await phone.fill('')
    await phone.pressSequentially('hello')
    await expect(phone, 'letters were accepted into a phone field').toHaveValue('')

    await phone.pressSequentially('2085550134')
    await expect(phone).toHaveValue('(208) 555-0134')

    // Mixed input keeps only the digits rather than refusing the whole thing.
    await phone.fill('')
    await phone.pressSequentially('abc208def555ghi0134')
    await expect(phone).toHaveValue('(208) 555-0134')
  })

  test('a pasted +1 number is accepted, not refused', async ({ page }, info) => {
    test.skip(info.project.name === 'phone', 'covered once, on desktop')

    await page.goto('/app/book')
    const phone = page.getByLabel('Phone')

    // Through the FIELD, not the formatter. The unit test for this passed while the field was
    // broken: `maxLength={14}` clipped the 15-character paste before the formatter ever saw it,
    // and `+1 208 555 0134` silently became `(120) 855-5013` — a plausible wrong number, which
    // is far worse than a rejected one.
    await phone.fill('+1 208 555 0134')
    await expect(phone, 'a pasted country code corrupted the number').toHaveValue('(208) 555-0134')

    await phone.fill('1 (208) 555-0134')
    await expect(phone).toHaveValue('(208) 555-0134')
  })

  test('an email without an @ says so, and the message clears when fixed', async ({
    page,
  }, info) => {
    test.skip(info.project.name === 'phone', 'covered once, on desktop')

    await page.goto('/app/book')

    const email = page.getByLabel('Email')
    await email.fill('keoni.example.com')
    // On blur, not on every keystroke — telling somebody their email is invalid while they are
    // typing the third character is true and useless.
    await email.blur()
    await expect(page.getByText(/needs an @/)).toBeVisible()

    // Once an error is showing, a correction clears it immediately rather than making them tab
    // away to find out they fixed it.
    await email.fill('keoni@example.com')
    await expect(page.getByText(/needs an @/)).toHaveCount(0)
  })

  test('nothing is said while the field is still being filled in', async ({ page }, info) => {
    test.skip(info.project.name === 'phone', 'covered once, on desktop')

    await page.goto('/app/book')
    const email = page.getByLabel('Email')
    await email.pressSequentially('keo')

    await expect(
      page.getByText(/doesn’t look like an email|needs an @/),
      'the field complained before the person had finished typing',
    ).toHaveCount(0)
  })
})
