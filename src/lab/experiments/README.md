# Lab experiment modules

Client-only Lab experiments live in this directory. Each module exports a
`mount` function matching `ExperimentModule` from `src/lab/types.ts` and is
loaded only by its `/lab/[slug]` page.
