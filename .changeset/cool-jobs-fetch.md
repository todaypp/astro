---
"astro": minor
---

Adds a new `experimental.directRenderScript` option.

This option replaces the `experimental.optimizeHoistedScript` option to use a more reliable strategy to prevent scripts being executed in pages they are not used. The scripts are now directly rendered as declared in Astro files (with features like TypeScript and importing `node_modules` still intact), and should result in scripts running in the correct pages compared to the previous static analysis approach. However, as scripts are now directly rendered, they are no longer hoisted to the `<head>`, which you may need to check if it affects your site's behaviour.