# Community scorecard rounds

Rounds run by people outside Bendyline with `gezel bench`, one JSON file per
round. They are published in their own section of the model scorecard page,
never mixed into Bendyline's rounds, the model pages, the model catalog's
measured column, or `gezel doctor`.

## How a round gets here

1. Someone runs `gezel bench --json result.json` (any suites, any count) and
   then `gezel bench submit result.json`, which opens a `bench-result` issue
   with the file attached. The issue form is
   `.github/ISSUE_TEMPLATE/bench-result.yml`.
2. A maintainer checks the file:
   - it parses as a `ScorecardDataset` with exactly one run
     (`gezel bench submit` already refuses anything else);
   - the run id is unique; prefix it `community-` if it is not already, so it
     can never collide with a Bendyline round (core refuses a clash at load);
   - the device, versions and trial count in the provenance look plausible
     for the hardware named in the issue.
3. Save it here as `<run-id>.json`, run `pnpm scorecard:barrel`, and commit
   the shard with the regenerated `../index.ts`.

The numbers are the submitter's, measured on their machine. The scorecard page
says so beside them; a maintainer checks the file's shape and plausibility, not
the result itself.
