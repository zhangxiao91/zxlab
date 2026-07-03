## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## OFFICIAL Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)


## Project purpose

ZXLab is a hand-built personal website for projects, notes, writing, and
technical experiments.

The main site architecture and visual language are human-authored.
Agents may extend the site only within the established system.

Read `docs/visual-guidelines.md` before making interface changes.

## Technology

- Astro
- TypeScript
- Native CSS
- Markdown Content Collections
- Static output

Do not add a frontend framework, component library, CSS framework, database,
or runtime service unless the user explicitly approves it.

## Architecture

Use the existing responsibilities:

- `src/pages/` defines routes and page-level composition
- `src/layouts/` defines shared page shells
- `src/components/` contains reusable interface components
- `src/data/` contains structured project data
- `src/content/` contains long-form Markdown content
- `src/styles/global.css` contains the current visual system
- `public/` contains static files copied without processing

Prefer extending existing components over duplicating markup.

Do not create abstractions for one-off fragments unless they clearly improve
readability or reuse.

## Visual constraints

Follow `docs/visual-guidelines.md`.

Do not introduce:

- Gradients
- Glassmorphism
- Glow effects
- Decorative floating objects
- Excessive cards
- Arbitrary colors
- Arbitrary spacing values
- New shadows or radii without updating the visual system
- Decorative icons without semantic value
- Motion without a clear interaction or state purpose

Prefer borders, whitespace, typography, and alignment.

## Design tokens

Use the existing CSS custom properties in `src/styles/global.css`.

Before adding a new token:

1. Check whether an existing token is suitable.
2. Explain why a new token is needed.
3. Add it to the shared token section.
4. Document any meaningful visual-system change.

Do not scatter hard-coded design values across page files.

## Content

Preserve human-authored copy unless the user explicitly asks for rewriting.

Do not insert generic marketing phrases, fake testimonials, invented metrics,
or placeholder statistics.

Use real project and note content.

## HTML and accessibility

- Prefer semantic HTML
- Maintain a logical heading hierarchy
- Preserve keyboard accessibility
- Use `aria-current="page"` for active navigation
- Add meaningful accessible names where needed
- Keep focus states visible
- Do not use clickable `div` elements
- Do not convey state through color alone

## JavaScript

Astro pages should remain static by default.

Do not add client-side JavaScript when HTML and CSS are sufficient.

When client-side behavior is necessary, keep it local and explain why
hydration is required.

## Responsive design

Use content-driven responsive decisions.

Preserve the existing narrow-screen behavior unless a change is justified.

Test interface changes at approximately:

- 375px
- 768px
- 1440px

Do not design only for the current desktop viewport.

## Workflow

Before editing:

1. Inspect the relevant files.
2. Explain the intended change.
3. Identify which existing components and tokens can be reused.

After editing:

1. Run `git diff --check`.
2. Run `npm run build`.
3. Review desktop and narrow-screen behavior.
4. Summarize changed files and architectural consequences.

Do not commit, push, install dependencies, or alter deployment configuration
unless the user explicitly requests it.

## Scope control

Avoid unrelated cleanup.

Do not rewrite working code merely to apply a preferred style.

When an architectural or visual decision is ambiguous, present the options
before making a broad change.