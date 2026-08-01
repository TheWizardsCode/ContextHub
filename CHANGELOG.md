# Changelog

## Unreleased
### Features
- Show total actionable count in browse list title ("top N of M") with auto-refresh (WL-0MS4FIEN40037GB9)
- Smart selection: always show critical and completed/in_review items in TUI lists (WL-0MS8W5LTW006YZ4B)
- Hide child work items from top-level selection lists; drill down via Tab (WL-0MS964SIA0057ABR)
- Navigation stack for hierarchical browsing in Herdr plugin (WL-0MS4FI763006105Y)
- Missing text-insertion shortcuts: i/r/u-p-*/u-s/u-t/x-c/x-d/a-a/a-y/a-r chords (WL-0MS4FHW290053SH4)
- Auto-sync: periodic background wl sync (WL-0MS4FIUYS001K08K)
- Run !/!! prefixed commands visibly in a new herdr pane; keep output pane open (WL-0MS7MFILJ0079283, WL-0MS9HIUE0002JAKQ)
- Total actionable count display in detail view with GitHub issue number (WL-0MS4FIM8T001XAVF)
- Rich settings: browseItemCount and showHelpText toggle (WL-0MS4FJ2TX009V7V5)
- Skills and commands run in correct project directory (WL-0MS8SVY7P0094K6D)

## v1.0.3 (2026-07-11)
### Features
- Add periodic request scheduling with cron expressions to Worklog pi extension (WL-0MRHYQU1S009DJ9B)
- Extend doctor upgrade to refresh installed hooks from .githooks (WL-0MRDEM7OO005UB1H)
- Session Health Extension for Pi Footer (WL-0MRDRZ32L00404D0)
- proactively release leases (WL-0MRE6JDT3004OSTF)
- Show time since last streaming chunk in session health footer (WL-0MRERDU1J000W1IS)
- Add model/provider line to TUI status bar footer (WL-0MRF19R71004YJND)
- Show initial prompt preview in footer info line (WL-0MRF6JXMD003KHLQ)
- Restructure session health footer: elapsed time next to state, total session time in center (WL-0MRFJGLI4009GLEE)
- Compact footer status line: shorten skill indicator and truncate work item IDs (WL-0MRFOJFVA003S8IB)
- Show initial prompt preview in footer info line (WL-0MRF6JR7P005TJU9)
### Bug Fixes
- RCA: wl sync pre-push hook destroyed Tableau-Card-Engine repository (WL-0MRCTZZ82000X7TM)
- Fix extractInitialPrompt to handle Pi's array-based content format (WL-0MRFH8W4J007HIY5)
### Other
- Move provider/model display to start of Worklog extension status line (WL-0MRC91VIN0089UXD)
- Fix pre-existing test failures in unrelated test files (WL-0MRFMOU4Q009GUWH)
- Integrate model-display extension into the Worklog extension (WL-0MRC3F30E008XJN3)
- Change audit/review question mark icon from red to grey in selection list (WL-0MRCN2HF5003HSG9)
- Model display extension is not showing the provider (WL-0MRC3NOVZ000P0P5)

## v1.0.2 (2026-07-08)
### Other
- Integrate model-display extension into the Worklog extension (WL-0MRC3F30E008XJN3)
- Move provider/model display to start of Worklog extension status line (WL-0MRC91VIN0089UXD)
- Change audit/review question mark icon from red to grey in selection list (WL-0MRCN2HF5003HSG9)
- Model display extension is not showing the provider (WL-0MRC3NOVZ000P0P5)

