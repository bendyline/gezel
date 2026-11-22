---
id: saved-web-pages
title: "Saved web pages: let Gezel read the web without browsing it"
order: 7.8
summary: Follow web pages from a project. Gezel keeps a copy of each one, with screenshots, refreshes it, and tells you what changed, so Gezel can work from the web without browsing while it works.
---

# Saved web pages

A project can follow web pages: a product's documentation, a supplier's price list, a team wiki, a news section. Gezel visits each page in its own browser, keeps a copy of what it says and a few screenshots of how it looked, and checks again on a schedule. When Gezel works on your project, it reads those copies. It never browses while it works, so a page can't steer it anywhere, and nothing it writes can leave through an address.

## Follow a site

1. Open the project's **Connections** tab, choose **Add connection**, then **Websites**.
2. Paste one or more addresses, separated by commas. A bare site name like `example.com` works.
3. Choose how far to follow links (2 means the pages it links to, and the pages those link to), how many pages to keep, and how often to check for changes.
4. Press **Add**. Gezel saves the first pages right away and keeps going in the background.

Links are followed inside the folder of each address: `https://example.com/docs/` stays inside the docs. Gezel goes slowly, at most one page every second or two, and follows the site's rules for crawlers.

## Save one page

To keep a single page, write its address in a chat, starting with `https://` or `www.`, or press **Save a page** in **Web pages** once the project follows a site. A line above the message box says the page will be saved here and included in the chat. When you send the message, Gezel saves the page first and includes it with your message, so "Can you summarize https://example.com/pricing?" works as you'd expect. Press **×** on that line if you don't want the page fetched, or **Save now** to save it before you finish writing. Under your sent message, a row with the page's title opens the saved copy. A page saved this way isn't refreshed on its own; press **Sync now** on its connection when you want a fresh copy.

## Read what was saved

The project's **Web pages view** tab lists the pages by site. Choose one to read it. **Reading** shows the page's text; **Screenshots** shows how it looked. A link to another saved page opens it here; any other link opens in your browser. When Gezel has written a short synopsis of a page, it appears at the top, marked as written from the page.

Each site also gets two files Gezel reads: an **overview** of every saved page, and a **change log** for the month listing pages that appeared, changed (with the lines that changed) and disappeared.

## Get told when a page changes

In **Connections → Lookouts**, choose the site and what to watch for: a page that changed, a new page, or words that appear (for example "sold out" or "version 2.0"). You can limit it to part of the site, like `/pricing`. Then choose what happens: a notification, a sound, a message to your phone, an email, or having Gezel look into it. Gezel checks each time it refreshes the site.

## Sites you sign in to

For pages behind a sign-in, press **Sign in…** on the site's connection. Gezel opens a browser window: check the address bar shows the site (or the sign-in service it uses), sign in as you normally would, then come back and press **Done**. Gezel keeps the sign-in for that connection only, encrypted on your computer, and never sees your password.

If the site signs you out later, Gezel stops refreshing it, keeps every page it saved, and the connection says *Signed out — sign in again*. Press **Sign out** to forget the sign-in.

When signed in, Gezel is stricter: it only follows links inside the addresses you gave, and never follows links that could change something (sign out, delete, buy, approve).

## When Gezel needs a page it has not saved

While it works, Gezel can save a page it already found as a link on a site you follow, and then read it. For any other address it asks you first, and you decide whether to save it. You can make Gezel ask you every time from the connection's **Edit**.

## What Gezel never does

- It never clicks, types or fills in anything on a page. Cookie banners are hidden, not accepted.
- It never downloads files from pages or grants a page any permission.
- It can't reach your home or office network from a page, except a private site you typed yourself, like an intranet wiki.
- A page that shows a bot check, a sign-in form, or almost nothing never replaces a copy Gezel already has.

Some sites refuse automated visits. Those pages are listed as *could not be saved*, with the reason.

## Where it works

At the default security level, sites refresh on their own whenever this computer may use the network for you (**Settings → Security & compliance → App network**). Turning that off stops a visit in progress.

Gezel uses the browser it downloads for itself. Until that download finishes, or where the browser can't run safely, pages are saved as text only, without screenshots, and the connection says so.
