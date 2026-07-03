
# ZXLab

ZXLab is my personal site for projects, technical notes, and experiments.

The main site is built by hand to understand the frontend architecture,
visual system, content pipeline, and deployment process before using agents
to extend it.

## Tech stack

- Astro
- TypeScript
- Native CSS
- Markdown Content Collections
- Static site generation

## Local development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## Project structure

```text
src/
├── components/     Reusable interface components
├── content/        Markdown notes
├── data/           Structured project data
├── lab/            Lab project definitions and lazy experiment modules
├── layouts/        Shared page shells
├── pages/          File-based routes
├── status/         Public status types, providers, and client boundary
└── styles/         Global styles and design tokens
```

Static files that should be copied directly are stored in `public/`.

## Main routes

* `/` — Homepage
* `/projects` — Project archive
* `/notes` — Notes archive
* `/lab` — Interactive experiment index
* `/lab/[slug]` — Isolated experiment container
* `/status` — Public, privacy-filtered status dashboard
* `/about` — About page

Project and note detail pages are generated from shared data and content
collections.

## Design

The interface is intentionally restrained, editorial, and content-driven.

See:

* `docs/visual-guidelines.md`
* `docs/lab-status.md`
* `AGENTS.md`

## Status

The first hand-built version is under active development.
