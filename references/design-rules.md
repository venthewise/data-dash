# data-dash design rules

The built-in theme already follows these. Apply them when writing specs and when scoring screenshots.

## Page

- One question per dashboard, in the subtitle. If a widget doesn't help answer it, cut it.
- Reading order: KPIs (answer) → trend (why/when) → ranking (where/who) → detail table (proof). 3-4 KPIs, not 8.
- 12-column grid, 16px gaps, cards with a 1px border, 10px radius, no shadows. Spans in a row add up to 12. Mobile is one column; KPIs full width.
- One typeface (embedded Inter subset or system stack), tabular figures for numbers. Sizes: title 26, KPI value 34 (26 mobile), card title 14, labels 12-12.5.
- Colour: neutral ink + one accent. Categorical series from the theme palette (6 max, each ≥3:1 on the card). Ordinal categories (bands, tiers) get one hue in steps (`colors:` light→dark). Up/down colours only on deltas where direction has a meaning (`good: up|down`); otherwise `neutral`.
- No gradients, glows, shadows on marks, 3D, rounded "pill" bars, background images, emoji, or decorative icons.

## Numbers

- Every number comes from data. Spec text holds no digits (titles like "Top 10" are generated from `limit`; defined terms go in `allow_terms`).
- Units on everything: KPI suffix, value-axis name, table header. Currency and percent formats carry their own unit.
- Round for reading: compact axis ticks (`12K`), full values in tooltips, tables and the drawer. Pick `decimals` once per measure.
- Deltas say what they compare: "▲ +4.2% vs prior 12 months (2,059)". Equal-length windows only.

## Time

- Completeness comes from `data_through`, never the viewer's clock.
- Incomplete first/last buckets: hatched bars and heatmap columns, dashed line segments, plus a generated note. Never extrapolate.
- Show the period every chart covers (generated caption) so KPIs over 12 months and charts over the full range aren't confused.
- Use UTC unless the data says otherwise; say "UTC" in date filter labels.

## Charts

| Need | Use | Avoid |
|---|---|---|
| change over time | line (few series) or bar (counts per period) | area stacks with >4 series |
| composition over time | stacked bar | stacked lines |
| ranking | horizontal bar, sorted, value labels | vertical bars with rotated labels |
| relationship | scatter, low opacity | bubble charts with 3 encodings |
| intensity across two categories | heatmap, single-hue ramp from the card colour | rainbow scales |
| part of whole (2-5 parts) | donut | pies with >5 slices, multiple pies |
| exact values / lookup | table, sortable, right-aligned numbers | charts with every value labelled |

- Value axes start at zero for bars; lines may use `y_scale: true` when the variation is the point (say so in the subtitle).
- Legends top-right; value-axis unit top-left; no axis lines on value axes; light gridlines.
- Category labels truncate with an ellipsis at ~26 chars desktop / 16 mobile; full text in the tooltip.
- Tooltips: period or category as the header, then `● series: value unit`.

## Accessibility

- WCAG AA: text ≥4.5:1, chart marks ≥3:1 (checked). Don't encode by colour alone: hatching marks partial periods, labels carry values.
- Buttons are real buttons with labels ("Show source data for …"); the drawer is a dialog, Esc closes it, focus returns.
- ECharts `aria` is on, so charts get generated descriptions.

## Review checklist (beyond `check`)

- Does the top row answer the question at a glance on a phone?
- Would a reader ask "compared to what?" or "as of when?" anywhere?
- Is any chart repeating another one's message? Cut it.
- Is there one obvious place the eye goes first?
