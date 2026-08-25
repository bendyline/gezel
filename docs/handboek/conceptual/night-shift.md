---
id: night-shift
title: "The Night Shift: work your crew does while you sleep"
order: 7.5
summary: A nightly window for quiet background work — and the roles that bring their own.
---

# The Night Shift: work your crew does while you sleep

The **Night Shift** is a window — 22:00 to 06:00 unless you change it in
Settings — when your crew is allowed to work on things that don't need
you. Reviews get written, indexes get refreshed, translations catch up.
In the morning there's a report waiting instead of a backlog.

The moon in the title bar shows when a shift is running and what it's
working on. It also says **when the period started and when it ends** —
a scheduled shift closes with its window, a manual one runs until the
work is done — and keeps a **running tally** of what the shift has got
through: tasks finished, files indexed and reviewed, files written,
questions raised for you. During the day the same line tells you when
the next window opens. You can start a shift manually too — stepping out
for lunch is a perfectly good night.

## Roles that bring their own night work

Some roles come with a standing suggestion for recurring work that suits
them. Add a Chief Security Officer to a project, and they'll suggest a
nightly security review; a Translator suggests keeping a translated
shadow of your content in the project's designated language. The same
goes for project types — a project set up for a job hunt suggests its
weekly pipeline review.

These are **suggestions, never surprises**: nothing runs until you turn
it on. The toggles live with the crew list in each project's Settings,
and appear the moment a suggesting role joins. Turning one off pauses it
— your run history stays — and "don't suggest this" hides it for that
project.

::handboek-suggested-work

## What night work looks like

Night work is deliberately quiet-handed. The suggested craftbooks write
**reports, findings, and sidecar files** — a security posture report in
the artifacts drawer, translations beside the originals — rather than
editing your work in place. Each enabled item runs **at most once per
night**, inside the window. Its task transitions and tool completions that
Gezel observes land in History like other work.

Some values are shared across night work: the Translator's target
language, for instance, is a **project property** — set once in project
Settings (or the first time you enable the translation run) and reused by
every run after that.

## Keeping your subscription quota safe

Night work on a Claude, Codex, or Copilot subscription spends the same
quota you use during the day, so the Night Shift keeps a **quota
reserve**: by default it stops sending work to a subscription once you're
within 20% of a quota, leaving the rest for you. You can adjust that
floor in Settings → Night Shift, or add a daily reserve that scales with
the time left — 10% a day with four days until your quota resets keeps
the last 40% for you.

Work that's already running always finishes; only new work is held. Held
work resumes on its own when a quota window resets (if the machine is
awake) or the next night, and the moon menu says what's being protected
and why. Gezels on local models spend nothing and are never held.

## Fixes that arrive as proposals

A project with both a **Boekwachter** and a **developer** on its crew gets one
more kind of night work: the Boekwachter finds problems in your files, and
overnight the developer works through them.

What arrives in the morning is not a changed project. It's a set of **change
proposals** — one per group of problems the developer judged worth fixing
together, each with the reasoning written out and the exact edits laid out
line by line. Your files are untouched. You read the proposal, look at the
diff, and apply it if you agree.

That's deliberate, and it has a useful consequence: **it works on folders your
crew isn't allowed to edit.** You never have to hand over write access to get
a fix drafted. It also works with nothing but the model on your own machine —
no network, no service, nobody's cloud.

Proposals live in the project's **Proposals** tab, which appears once there's
something in it. Each one shows:

- what the developer changed and why, what they were unsure of, and how to
  check it
- every file it touches, with the diff
- **Apply** (all of it, or one file at a time), **Export** (a zip of patches
  you can `git apply` yourself), or **Dismiss**

Two things it will tell you plainly. If a file changed after the proposal was
written — you edited it, or a teammate did — the proposal is marked **out of
date** and applying it asks you to confirm first, naming the files that moved.
And if two proposals touch the same file, both say so, because applying one
will put the other out of date.

You can start the same thing by hand any time: open a file the Boekwachter has
flagged, and hit **Fix** on the issue. It doesn't wait for nightfall, and it
produces the same reviewable proposal.

If you'd rather your crew didn't do this, turn off nightly fixing in the
project's settings. It's on by default only because you assembled a crew that
can do it.

## The morning review

When the window closes, gezel gathers what the shift accomplished and
puts it where you'll see it: the moon menu grows a **Done last night**
list, the Home greeting gains a **Last night** tab, and a single
question card summarizes the night with links to every report and every
change proposal waiting on you.

Reports can go further than prose. A recommendation that is genuinely
one click away — fire a craftbook, delegate a fix, apply a reviewed set
of file edits — appears **inside the report as an action card**. You see
exactly what would run (including the full diff for file edits) and fire
it, or dismiss it, right from the page. Nothing a report suggests ever
runs on its own: firing is always your click, and Gezel records the
resulting task and observed tool activity in History.

For the Night Shift to run while the app is closed, enable the background
service in Settings.
