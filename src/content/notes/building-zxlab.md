---
title: "Building ZXLab by hand"
description: "Notes from building a personal website from an empty Astro project."
publishedAt: 2026-07-03
tags:
  - Astro
  - Web
  - Learning
draft: false
cover: "https://picsum.photos/seed/editorial-code-study/1800/1200"
coverAlt: "Abstract monochrome editorial forms representing a hand-built digital workspace"
accent: "#d8ff73"
---

I started ZXLab with two constraints:

1. Build the main site by hand.
2. Define a visual system before asking agents to extend it.

The goal is to understand the structure well enough that automation remains a tool rather than a source of architectural mystery.

## Why begin by hand

Starting from an empty Astro project made every early decision visible. Routing, shared layouts, content models, metadata, and responsive behavior could not disappear behind a prebuilt theme.

That does not mean every layer needs to remain handmade forever. It means I want to understand the shape of the system before deciding where automation is useful.

> The aim is not to avoid tools. It is to keep architectural choices legible after the tools have done their work.

## Structure before surface

The first version separates reusable interface pieces from content and route-level composition:

```text
src/
├── components/   Shared interface pieces
├── content/      Markdown notes
├── data/         Structured project records
├── layouts/      Page shells and metadata
├── pages/        File-based routes
└── styles/       Design tokens and page systems
```

That separation keeps the content pipeline deliberately small. Projects live in typed data, while longer writing uses Astro Content Collections and a validated frontmatter schema.

| Layer | Source of truth | Purpose |
| --- | --- | --- |
| Projects | `src/data/projects.ts` | Structured project metadata |
| Notes | `src/content/notes/*.md` | Long-form Markdown writing |
| Interface | Astro components and pages | Semantic presentation |

### Content as a first-class layer

A note is not a blob of HTML pasted into a page. Its title, description, publication date, tags, and draft state are validated before the site builds. The Markdown body stays portable and readable without the surrounding interface.

## What the first version established

The initial hand-built pass produced:

- A shared document layout with canonical and social metadata.
- Static routes for the homepage, projects, notes, About page, and error page.
- A typed project data layer and Markdown content collection.
- Responsive behavior without a component framework or utility CSS dependency.
- A production build deployed through Cloudflare Pages.

The visual experiments on the `beta` branch now sit on top of that foundation. They can be changed aggressively without changing how the underlying content is stored.

## A constraint worth keeping

The most useful constraint is simple: **understand the system before hiding it**. It encourages small interfaces, explicit data flow, and fewer dependencies added only for convenience.

When a new abstraction arrives, it should solve a problem the existing code has made concrete. That is a slower way to begin, but a clearer way to continue.

## What comes next

ZXLab will keep accumulating projects and notes as the work develops. Project pages will gain real screenshots and process material when those sources are ready, and the notebook will remain the place for decisions that do not fit inside a polished case study.

The current implementation can be explored through the [ZXLab project page](/projects/zxlab).
