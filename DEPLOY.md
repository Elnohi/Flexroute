# FlexRoute update, 30 October 2026

Everything here mirrors your repo layout. Upload with the same paths (GitHub: Add file > Upload files; drag the folders).

## 1. Upload in this order

**A. Backend first** (new files, nothing existing changes)
- `netlify.toml` (adds two daily schedules; everything else in it is unchanged)
- `netlify/functions/_pass-links.js`
- `netlify/functions/renew-pass.js`
- `netlify/functions/pass-reminder.js`
- `netlify/functions/purge-old-records.js`

**B. Pages**
- `privacy.html`, `tos.html`, `refund.html`, `security.html`
- `index.html` (landing page)
- `compare/index.html`, `compare/fixmyroute.html`, `compare/routerra.html`
- `sitemap.xml`

**C. App** (only the email prompt wording changed)
- `flexroute.html` (v2026.10.30-v57) and `sw.js` (flexroute-v57)

Deploy B together with A. The privacy policy states retention periods that the purge job enforces.

## 2. Settings in Netlify (Site configuration > Environment variables)

| Variable | What to do |
|---|---|
| `REVIEW_EMAILS_ENABLED` | Already used by the other automatic emails. The pass reminder uses the same switch. Leave as it is. |
| `REVIEW_EMAILS_DRY_RUN` | Set to `1` for the first day if you want to see the pass reminder before customers do: every email goes to you instead. |
| `PURGE_DRY_RUN` | Set to `1` for the first day. The purge job then only reports what it WOULD delete. Remove it once the numbers look right. |
| `PURGE_DISABLED` | `1` turns the purge job off completely (the privacy policy would then be wrong, so use only temporarily). |

No new secrets are needed. The renewal link is signed with the secret the unsubscribe links already use
(`REVIEW_EMAILS_SECRET`, or `STRIPE_WEBHOOK_SECRET` if that is not set).

## 3. Check it worked

1. Open the app, close it fully, open it again twice. The report (tap the stop-count heading 5 times) should say **v2026.10.30-v57**.
2. Netlify > Functions > `purge-old-records` > Logs: look for `purge-old-records summary` after 04:00 UTC (or run it from the Functions page).
3. Pass reminder: it only sends for a pass ending in 2 to 4 days, so it may say `due: 0` until one exists. `pass-reminder summary` in the logs shows what it looked at.
4. Open flexrouteapp.com/compare/ and the footer link on the landing page.

## 4. Decisions that are yours (not code)

- **Analytics settings.** The privacy policy says Google Analytics is not used for advertising and keeps data no more than 14 months. In Google Analytics > Admin, check that Google signals / ad personalization are OFF and data retention is 14 months or less.
- **UK / EU visitors.** Analytics cookies and the free-trial device identifier normally need consent there. The policy now discloses both accurately; a consent banner is a separate piece of work. Consider a short legal check.
- **Landing page claims I could not verify and left alone:** "Built by a Flex driver, for Flex drivers"; the "Drivers in 15 countries" list (Brazil and Spain are missing from it, going by your October analytics); and "no paid marketing". Confirm or edit.
- **Existing check-in email.** It says "If FlexRoute is saving you time, a short review helps..." Asking for a review only from people who are happy can count as review gating. Consider dropping the "If FlexRoute is saving you time" part.
- **Device identifier.** It is a 32-bit hash, so two identical phones could share a free-route count. The policy tells people to email you if that happens. Worth watching.

## 5. If anything looks wrong: undo it in one minute

Nothing in this update touches your data, and nothing is deleted from the repo. To go back:
- **Fastest (Netlify):** Deploys > pick the last deploy from before this update > **Publish deploy**. The site is back to exactly how it was, instantly.
- **Cleaner (GitHub):** open the commit you uploaded and choose **Revert**. Netlify redeploys the previous files.
- **Just the retention job:** set `PURGE_DISABLED=1` in Netlify. It then does nothing.
- **Just the pass reminder:** unset `REVIEW_EMAILS_ENABLED`. It then sends nothing (this also pauses the other automatic emails).

What this update cannot undo by itself: records the retention job has already deleted (this is why `PURGE_DRY_RUN=1` on the first day is recommended), and emails already sent.
