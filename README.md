# Zhihu User Activity Watcher

Tampermonkey userscript for exporting a visible activity timeline from a Zhihu user's profile activity page.

## Install

[![Install userscript](https://img.shields.io/badge/Install-userscript-2ea44f?style=for-the-badge)](https://raw.githubusercontent.com/plsy1/zhihu-user-activity-watcher/main/zhihu-activity-watcher.user.js)

Install Tampermonkey first, then click the button above. Tampermonkey should open the userscript installation screen automatically.

The script includes `@updateURL` and `@downloadURL`, so future updates pushed to the `main` branch can be picked up by Tampermonkey's normal update check.

## Use

1. Install Tampermonkey in your browser.
2. Click the install button above.
3. Visit a Zhihu profile, for example `https://www.zhihu.com/people/<token>/activities`.
4. Use the floating panel:
   - `动态页`: jump from the profile page to the activity page.
   - `开始`: slowly scroll and collect rendered activity items.
   - `暂停`: stop scrolling.
   - `JSON`: export structured timeline data plus the analysis prompt.
   - `CSV`: export timeline rows for spreadsheets.
   - `AI`: export a Markdown file that contains an analysis prompt, readable timeline, and raw JSON. It also opens an in-page preview for copying.
   - `清空`: clear records stored in browser localStorage.

## Exported fields

Each captured item is normalized into a timeline row:

- `actionType` / `actionLabel`: activity type, such as voteup, follow, answer, collect, or article.
- `targetType`: inferred target type, such as answer, question, article, person, column, or collection.
- `targetTitle`: visible title or text from the activity card.
- `targetUrl`: Zhihu URL for the activity target when visible.
- `timeText`: original time text shown by Zhihu.
- `timeIso`: best-effort parsed timestamp. It is left empty when parsing is uncertain.
- `summary`: compact text from the visible card.

## AI workflow

Use the `AI` button when you want to paste the export into a large language model. The Markdown file includes a prompt asking the model to:

- Build a cautious public-activity user profile.
- Analyze interests, hobbies, preferred topics, and repeated content patterns.
- Summarize behavior habits, such as liking, following, answering, or collecting.
- Identify active dates, active hour ranges, and unusually dense activity windows.
- Infer possible non-sensitive background categories, such as broad professional, learning, or interest areas, with confidence levels and evidence.
- Separate facts, weak signals, and unsupported conclusions.
- Avoid real identity discovery, contact lookup, precise location inference, or sensitive personal inferences.

The readable timeline in the AI Markdown omits links to reduce token usage. Full `targetUrl` values are still included in the raw JSON block and in JSON/CSV exports.

## Approach

The script does not bypass login checks, CAPTCHA, rate limits, or access controls. It reads activity cards already rendered in the browser DOM and scrolls at a conservative interval.

This is usually more maintainable and less likely to trigger anti-abuse systems than high-frequency backend requests, but it has tradeoffs:

- It only captures content the current account can see.
- It depends on Zhihu's frontend DOM structure.
- It may miss items if the page changes, lazy-loads slowly, or hides content behind interaction.
- It is not suitable for large-scale crawling.

## Notes

Use this for personal archival or monitoring of publicly accessible activity only. Respect Zhihu's terms, robots/rate-limit expectations, and user privacy.
