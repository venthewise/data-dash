# Vendored third-party assets

| File | What | Version | Licence | Source |
|---|---|---|---|---|
| `echarts.min.js` | Apache ECharts charting library (inlined into every built HTML) | 6.1.0 (sha256 `b66b25ae…0fd0`) | Apache License 2.0 (`ECharts-LICENSE.txt`, `ECharts-NOTICE.txt`); embedded d3.js-derived code is BSD 3-Clause (`ECharts-LICENSE-d3.txt`) | https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js |
| `inter-var-latin.woff2` | Inter variable font, subset to Latin + Latin-1/Ext-A + common punctuation, opsz pinned at 14, wght 400-700 (31 KB) | Inter 4.x | SIL Open Font License 1.1 (`Inter-OFL.txt`) | https://github.com/rsms/inter |

The built HTML keeps ECharts' licence banner in its `<script id="echarts-lib">` block. The font is embedded as a data URI under the name `Inter DD` (OFL-1.1 allows embedding and subsetting; Inter's licence declares no Reserved Font Name, and the embedded name `Inter DD` marks it as a subset).

To update ECharts: `curl -sSfL -o echarts.min.js https://cdn.jsdelivr.net/npm/echarts@<ver>/dist/echarts.min.js`, then run `dash.py check` on an example.
