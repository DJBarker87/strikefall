# Round-create performance evidence

With the production Compose stack healthy, run:

```sh
npm run test:performance:api
npm run test:performance:report
```

The benchmark uses ordinary anonymous-session and per-IP limits, performs three
warmups and 25 measured authoritative creates, and validates every response's
round identity, commitment, approach, and 19-bot roster. It writes `report.json`
before returning a failing status for a breached 300 ms maximum.

The report retains every raw duration, the derived percentiles, a SHA-256
inventory of all declared server/protocol/container source inputs, git/worktree
state, runner and Docker versions, and the exact healthy container and image IDs
that remained unchanged across the run. The checker recomputes the source
inventory and all summary statistics. CI uploads the JSON for 30 days.

`releaseBound: true` is possible only when the source set is clean, a real git
commit exists, and the built web and service OCI revision labels both equal that
commit. An uncommitted local run is still useful regression evidence, but it is
deliberately not release sign-off and does not establish physical-device or
real-radio latency.
