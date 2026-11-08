---
id: gezel-app-ux-guide
title: Gezel app UX guide
order: 13.5
summary: How a Gezel app is organized and how people act in it — Home, a tab per noun, Settings, action keys that open dialogs, and actions on the records themselves.
subcategory:
  id: developer
  title: Developer
  order: 3
---

# Gezel app UX guide

This guide says how an app page is organized and how people act in it. The [page style guide](gezel-app-page-style-guide.md) covers what Gezel supplies to a page and how it looks: fonts, color, controls, and states. [Using the Gezel page APIs](gezel-page-apis.md) covers the components named here.

It is a living standard. Each practice has a number, so a review can cite it ("B3: this form picks a record that is already on screen"). The open questions at the end record what is not settled. When a pass over the apps teaches something new, change the practice and add a line to the change list.

## Start from the app's shape

Most apps fall into one of five shapes. Pick the shape first; it decides the structure.

| Shape | Examples | Structure |
| --- | --- | --- |
| Workspace | Shift Roster, Sales Pipeline, Event Desk | Home, then one tab per noun the person manages, then Settings when there is something to set |
| Single list | Household Manual, Life Binder | One view with a key bar under the title and actions on each row |
| Board | Checkers, Chess, Word Clues | The board is the page. New game opens a dialog |
| Practice | Flashcards, Language Trainer | Home is today's practice, with tabs for what you collect and for progress |
| Collection | Media Library, Design Scheme | The gallery is the page, with filter keys, an Add key, and a preview dialog per item |

## A. Structure

**A1. One title and one summary line.** The `h1` names the person's subject when there is one ("Trip: Lisbon", "The Glass Cartographer"), otherwise the app. Under it, one line says the state in plain words and what needs attention: "The week is approved, with 2 spots still open." Compute it from the data; never leave a static description there.

**A2. Home comes first and answers "what needs me now?"** In a workspace app, Home holds up to four summary tiles, the list of things that need the person, the app's main view, and the app's top two or three actions.

**A3. One tab per noun.** Each thing the person manages (People, Deals, Quotes, Vendors) gets a tab with its full list, its search, and its create and update actions. Label tabs with short plural nouns in sentence case. Two to five tabs is right; more means two nouns should merge.

**A4. Settings comes last, and only when there is something to set.** Rules, rates, targets, and event or campaign details belong there. Settings forms are open on the tab, not behind a key, and show the values saved now. Never show an empty Settings tab.

**A5. No tab repeats Home.** When the app's main view already is a noun's list, that noun lives on Home and gets no tab of its own. Shift Roster's week grid is its list of shifts, so Shift Roster has Home, People, and Settings, and no Shifts tab.

**A6. Declare navigation; don't derive it from headings.** Many section headings are dashboard panels ("Coming up", "Reorder now"), not places to go. Name the tabs and what each holds. Do not add an "On this page" row of links.

**A7. A single-view app has no tabs.** A key bar under the title and actions on each row are enough. Add tabs when a second noun needs its own list, not before.

## B. Actions

**B1. An action is a key that opens a dialog.** Never put a form on the page behind an expandable card. The disclosure presentation of `actionForm` exists only for older pages. One exception: a quick add of one field and its key (a grocery item, a record's title) can sit open at the top of the list it adds to.

**B2. Three keys at most, and one filled primary per view.** The primary is the action that creates or commits. When the view already has a commit key of its own (Approve the week), every action key in that view is secondary.

**B3. Act on the record where it is.** When a form starts by picking a record that is already on screen (a shift, a deal, an invoice), put a small key on that record's row or card instead: Fill, Time off, Move, Mark paid. It opens the same dialog with the record filled in. Keep a general key only when people also start that action from nowhere in particular.

**B4. Dialogs follow one pattern.** The title is the action ("Add a person"), and fields sit in one column. Cancel comes before the verb on the right ("Assign", "Add person"). Escape and a click on the backdrop close the dialog. A failed save keeps the dialog open with the typed values and says what went wrong. A successful save closes it and confirms beside the key that opened it, and the page shows the change.

**B5. Ask before discarding work.** New game, remove, and anything else that loses state opens a dialog first.

**B6. Keys name a verb and its object.** "Add a shift", in sentence case. When the dialog title is long, give the key a shorter label.

## C. Showing records

**C1. Show values the way people say them.** Write "Thu, Nov 12", "$1,529", and "In review", never `2026-11-12`, `1529`, `in-review`, or an internal id like `ch-4`. Do date math in local time.

**C2. Color follows the value.** A count is ink. Red and amber mean a problem now, so 0 conflicts is not red. The accent is not a color for counts.

**C3. Empty states span their list and say how to fill it.** "Open spots appear here once the week has shifts." Never squeeze the message into a list's first grid column.

**C4. Say when a list is cut.** Write "Showing 4 of 12" when only part of a list is shown.

**C5. Search only long lists.** Show a search box from about eight items, inside the list's section, with a placeholder that says what to type ("Name or role"). Do not count the empty-state row as an item.

**C6. Everything the companion can change has a place on the page.** If the crew can edit sessions, past visits, or a voice guide, the person can see them somewhere.

## D. Color and type

The [page style guide](gezel-app-page-style-guide.md) holds the detail. These are the rules apps most often break.

**D1. Actions use Gezel's action color.** Primary keys, focus rings, and Send use terracotta. The app's own accent is identity: charts, bars, and chips. Never set `--gezel-component-accent` to restyle Gezel's components in an app color.

**D2. One demo banner.** The banner is a quiet parchment strip with Reset demo, the same in every app. It is a notice, not an action or an error.

**D3. Headings use PT Serif at weight 400.** Small uppercase labels and eyebrows use the UI sans. Do not mark one up as a styled-down `h2` or `h3`, which turns it serif.

**D4. Body text is about 16px.** Nothing you can press is smaller than 28px, and keys are 44px tall.

## E. The companion

**E1. The conversation's title says where you are, and its description suggests what to ask.** For example: "At the scheduling desk" and "Add a shift, mark when someone can't work, or ask where the week is short."

**E2. Keep the composer's placeholder to about 28 characters.** For example, "What changed this week?" A longer one is cut off in the panel.

**E3. Demo suggestions do real work on the page.** See [the sample conversation](gezel-page-apis.md#the-sample-conversation).

## Building it

The components carry most of these practices. A page on a current host (page components version 2) can use:

- `actionForm(mount, { presentation: 'dialog', primary, buttonLabel, ... })`. It draws a key that opens the form in a modal. Its handle's `open(values)` opens the form filled in, for a row's key. Use `trigger: false` for a dialog that only rows open.
- `actionForm(mount, { presentation: 'inline' })` for a settings form, with `reset(values)` to show what is saved.
- `tabs(mount, { tabs: [{ id, label, panel, badge }] })` for underline tabs over the page's own panels.
- `collectionFilter(mount, { ..., placeholder, minItems: 8 })` for search that appears only when it helps.

Feature-detect version 2 (`gezel.ui.components.version >= 2` and `typeof tabs === 'function'`). Keep an older host usable: there, an action form falls back to a disclosure.

Catalog apps in Gilde share one composition script, `application.js`. Its `config` declares the structure, and the script builds the tabs, keys, settings forms, and row dialogs from it:

```json
"tabs": [
  { "id": "home", "label": "Home", "sections": [".tiles", "#gaps-section", "#week-section"],
    "actions": ["add_shift", "assign_shift", "set_availability"], "primary": false },
  { "id": "people", "label": "People", "sections": ["#hours-section", "#away-section"],
    "actions": ["add_staff", "set_availability"] },
  { "id": "settings", "label": "Settings", "settings": ["set_rules"], "sections": ["#rules-section"] }
]
```

A row action is a button in the page's own markup. The shared script opens the matching dialog filled in:

```js
const fill = document.createElement('button');
fill.type = 'button';
fill.className = 'key';
fill.textContent = 'Fill';
fill.setAttribute('aria-label', `Fill ${dayName} ${shift.fields.start} ${shift.fields.role}`);
fill.setAttribute('data-app-action', 'assign_shift');
fill.setAttribute('data-app-values', JSON.stringify({ id: shift.id }));
```

Shift Roster 1.1.0 is the reference implementation. Its page shows Home, People, and Settings, Fill keys on open spots, Time off keys on each person, and a settings form that shows the saved rules.

## Review checklist

- [ ] The shape is chosen, and the structure matches it (A2–A7).
- [ ] The summary line says the state and what needs attention (A1).
- [ ] Every action opens a dialog. No view has more than three keys or more than one primary (B1, B2).
- [ ] Forms that pick an on-screen record are row keys (B3).
- [ ] No ISO dates, raw enum values, or ids are shown (C1). Tones follow values (C2).
- [ ] Empty states span their list. Search appears only on long lists, with a real placeholder (C3, C5).
- [ ] Actions and focus use the action color. The demo banner is the shared one (D1, D2).
- [ ] The page works at 420px wide without scrolling sideways, in dark mode, and with the keyboard.

## Open questions

- **Settings for what the person chose at creation.** A business name, an event date, or a weekly word goal is a project parameter. Pages can read these but not change them, so most of them cannot appear in Settings today. A host-drawn Settings form generated from the parameter schema would serve every app at once.
- **Nouns shared between apps.** Shift Roster, New Hire Onboarding, and Training Tracker each keep their own list of the same café staff. Should one business keep one People list?
- **Field types the forms lack.** A rating, a yes/no choice, a color, and amounts stored in cents. Without them, some actions stay a free-text field or stay out of Settings.
- **The companion's name on the page.** Pages know the crew member's role but not their name, so page text says "Your shift scheduler" while the conversation says "Nina".
- **Narrow tab rows.** The shell's tab rows trade labels for icons as they narrow. App tabs scroll instead, which works for short labels but is not the shell's rule.
- **Host-supplied tokens.** Pages still declare their own colors, spacing, and title sizes. A small shared set (action color, surfaces, title scale) would remove most of the drift this guide polices.

## Changes

- **November 7, 2026.** First version, from a review of 43 catalog apps. It covers the five app shapes, Home and noun tabs, dialog actions, row actions, inline settings, and value formatting.
