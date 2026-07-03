# Lab experiment modules

Client-only Lab experiments live in this directory. Each module exports a
`mount` function matching `ExperimentModule` from `src/lab/types.ts` and is
loaded only by its `/lab/[slug]` page.

Experiments that require a custom route can set `customPage` in the Lab data
model and keep their route-specific integration beside the relevant domain
module. Strudel uses this boundary for its iframe embed and does not add an
experiment bundle to other routes.
