/**
 * Labeled fixture pairs for the embedding-threshold calibration harness
 * (`evals/src/bin/embed-calibration.ts`). Texts are memory-shaped — the facts,
 * decisions, prefs, and statuses gezels actually save — because the thresholds
 * being calibrated (dedup, recall floors) gate exactly that corpus.
 *
 * Bands:
 * - `paraphrasePairs` — the SAME fact genuinely restated. Dedup should drop
 *   the second save (passage↔passage similarity above the dedup threshold).
 * - `distinctFactPairs` — the same topic, a DIFFERENT fact. Dedup must keep
 *   both (passage↔passage similarity below the dedup threshold).
 * - `unrelatedPairs` — different topics entirely. Anchors the noise floor.
 * - `relevantQueryPairs` — a search query and the memory it should surface
 *   (query→passage similarity above the recall/search floor).
 * - `unrelatedQueryPairs` — a search query and a memory it must NOT surface
 *   (query→passage similarity below the recall/search floor).
 */

export type Pair = [a: string, b: string];

export const paraphrasePairs: Pair[] = [
  ['The user prefers dark mode in every app.', 'User likes all their applications in a dark theme.'],
  ['Deploys go to the staging server at 10.0.0.12 first.', 'We deploy to staging (10.0.0.12) before anything else.'],
  ['The quarterly report is due on the last Friday of March.', 'Quarterly report deadline: final Friday in March.'],
  ['Mike decided to use PostgreSQL for the orders service.', 'Decision: the orders service will run on PostgreSQL (Mike).'],
  ['The client wants weekly status emails on Mondays.', 'Send the client a status email every Monday — their request.'],
  ['Build times regressed after the webpack 5 upgrade.', 'The webpack 5 upgrade made builds slower.'],
  ['Sarah owns the billing integration work.', 'Billing integration is Sarah’s responsibility.'],
  ['The API rate limit is 100 requests per minute per key.', 'Each API key is limited to 100 requests/minute.'],
  ['We agreed to keep all user data on the local disk.', 'Decision: user data stays on the local machine’s disk.'],
  ['The logo files live in the shared drive under Brand/2026.', 'Brand/2026 on the shared drive holds the logo assets.'],
  ['The user’s working hours are 9 to 5 Eastern.', 'User works 9am–5pm Eastern time.'],
  ['Invoices must include the PO number in the subject line.', 'Always put the PO number in an invoice’s subject.'],
  ['The test suite takes about twelve minutes on CI.', 'CI runs the tests in roughly 12 minutes.'],
  ['Customer demo scheduled for Thursday at 2pm.', 'Thursday 2pm: demo for the customer.'],
  ['The old importer is deprecated; use the v2 pipeline.', 'Use the v2 pipeline — the legacy importer is deprecated.'],
  ['Backups run nightly at 3am local time.', 'Nightly backups happen at 3:00am local.'],
];

export const distinctFactPairs: Pair[] = [
  ['The user prefers dark mode in every app.', 'The user prefers large fonts in every app.'],
  ['Deploys go to the staging server first.', 'Deploys require sign-off from two reviewers.'],
  ['The quarterly report is due the last Friday of March.', 'The quarterly report must include a churn analysis.'],
  ['Mike decided to use PostgreSQL for the orders service.', 'Mike decided to shard the orders service by region.'],
  ['The client wants weekly status emails on Mondays.', 'The client wants all invoices sent as PDFs.'],
  ['Build times regressed after the webpack upgrade.', 'Bundle size dropped 20% after the webpack upgrade.'],
  ['Sarah owns the billing integration work.', 'Sarah is on leave the first week of April.'],
  ['The API rate limit is 100 requests per minute.', 'The API returns paginated results in pages of 50.'],
  ['We keep all user data on the local disk.', 'We encrypt user data at rest with AES-256.'],
  ['The logo files live in the shared drive under Brand/2026.', 'The logo was redesigned in February 2026.'],
  ['The user’s working hours are 9 to 5 Eastern.', 'The user is unavailable on Wednesday afternoons.'],
  ['Invoices must include the PO number in the subject.', 'Invoices over $10k need finance approval.'],
  ['The test suite takes about twelve minutes on CI.', 'The test suite has three known flaky specs.'],
  ['Customer demo scheduled for Thursday at 2pm.', 'The customer asked for an on-prem deployment option.'],
  ['The old importer is deprecated; use the v2 pipeline.', 'The v2 pipeline still lacks CSV support.'],
  ['Backups run nightly at 3am local time.', 'Backup restores were last tested in January.'],
];

export const unrelatedPairs: Pair[] = [
  ['The user prefers dark mode in every app.', 'The quarterly budget review is on March 3.'],
  ['Deploys go to the staging server first.', 'Sarah’s dog is named Biscuit.'],
  ['The API rate limit is 100 requests per minute.', 'The office plants get watered on Fridays.'],
  ['Backups run nightly at 3am.', 'The client’s brand color is teal.'],
  ['The test suite takes twelve minutes on CI.', 'Lunch orders go in before 11am.'],
  ['Mike decided to use PostgreSQL.', 'The conference talk was accepted for October.'],
  ['Invoices must include the PO number.', 'The hiking trip is planned for Labor Day weekend.'],
  ['The logo files live in the shared drive.', 'Node 24 changed the default test runner output.'],
  ['The user works 9 to 5 Eastern.', 'The espresso machine needs descaling.'],
  ['The old importer is deprecated.', 'Parking validation is at the front desk.'],
  ['Customer demo is Thursday at 2pm.', 'The novel’s third chapter needs a rewrite.'],
  ['We keep user data on the local disk.', 'The marathon training plan starts in June.'],
  ['Build times regressed after the upgrade.', 'Grandma’s pie recipe uses tart apples.'],
  ['Sarah owns the billing integration.', 'The moon landing anniversary is July 20.'],
  ['The client wants weekly status emails.', 'Tire rotation is due at 40,000 miles.'],
  ['The quarterly report is due in March.', 'The aquarium’s new exhibit opens next month.'],
];

export const relevantQueryPairs: Pair[] = [
  ['what theme does the user like', 'The user prefers dark mode in every app.'],
  ['where do we deploy first', 'Deploys go to the staging server at 10.0.0.12 first.'],
  ['when is the quarterly report due', 'The quarterly report is due on the last Friday of March.'],
  ['which database did we pick for orders', 'Mike decided to use PostgreSQL for the orders service.'],
  ['how often does the client want updates', 'The client wants weekly status emails on Mondays.'],
  ['why are builds slow', 'Build times regressed after the webpack 5 upgrade.'],
  ['who is working on billing', 'Sarah owns the billing integration work.'],
  ['what is the API rate limit', 'The API rate limit is 100 requests per minute per key.'],
  ['where is user data stored', 'We agreed to keep all user data on the local disk.'],
  ['where are the logo assets', 'The logo files live in the shared drive under Brand/2026.'],
  ['what hours does the user work', 'The user’s working hours are 9 to 5 Eastern.'],
  ['what goes in an invoice subject line', 'Invoices must include the PO number in the subject line.'],
  ['how long do the tests take', 'The test suite takes about twelve minutes on CI.'],
  ['when is the customer demo', 'Customer demo scheduled for Thursday at 2pm.'],
  ['which importer should I use', 'The old importer is deprecated; use the v2 pipeline.'],
  ['when do backups run', 'Backups run nightly at 3am local time.'],
];

export const unrelatedQueryPairs: Pair[] = [
  ['what theme does the user like', 'Deploys go to the staging server at 10.0.0.12 first.'],
  ['where do we deploy first', 'The user prefers dark mode in every app.'],
  ['when is the quarterly report due', 'Sarah’s dog is named Biscuit.'],
  ['which database did we pick for orders', 'The office plants get watered on Fridays.'],
  ['how often does the client want updates', 'The espresso machine needs descaling.'],
  ['why are builds slow', 'The hiking trip is planned for Labor Day weekend.'],
  ['who is working on billing', 'Backups run nightly at 3am local time.'],
  ['what is the API rate limit', 'The novel’s third chapter needs a rewrite.'],
  ['where is user data stored', 'Customer demo scheduled for Thursday at 2pm.'],
  ['where are the logo assets', 'The test suite takes about twelve minutes on CI.'],
  ['what hours does the user work', 'The client’s brand color is teal.'],
  ['what goes in an invoice subject line', 'The marathon training plan starts in June.'],
  ['how long do the tests take', 'The logo files live in the shared drive under Brand/2026.'],
  ['when is the customer demo', 'The API returns paginated results in pages of 50.'],
  ['which importer should I use', 'Lunch orders go in before 11am.'],
  ['when do backups run', 'Mike decided to use PostgreSQL for the orders service.'],
];
