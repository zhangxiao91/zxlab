# ZXLab Visual Guidelines

## 1. Direction

ZXLab should feel:

- Restrained
- Editorial
- Technical
- Personal

The site should resemble a personal technical publication with occasional
elements of a systems dashboard.

Typography, spacing, hierarchy, and real content should create the identity.
Decoration should remain secondary.

## 2. Visual principles

### Content first

Every visual element should help communicate content, hierarchy, state, or
interaction.

Do not add decoration merely to make an empty area look busy.

### Editorial hierarchy

Use typography and whitespace to establish hierarchy.

Large headings may be expressive, while navigation, metadata, tags, and
supporting copy should remain quiet.

### Structured restraint

Prefer:

- Whitespace
- Thin borders
- Alignment
- Typography
- Subtle state changes

Avoid relying on shadows, gradients, glow effects, or excessive containers.

### Real content

Design pages around real projects, notes, data, and writing.

Do not use generic marketing copy or invented metrics as visual filler.

## 3. Color system

Current tokens are defined in `src/styles/global.css`.

- Background: warm off-white
- Primary text: near-black
- Muted text: neutral grey
- Borders: low-contrast neutral grey

Use a restrained palette.

New colors must have a semantic purpose and must be added as design tokens
before they are used in components.

Do not introduce page-specific arbitrary colors.

## 4. Typography

The current site uses a system sans-serif stack.

Typography rules:

- Use tight letter spacing for large editorial headings
- Keep body copy readable and moderately spacious
- Keep navigation and metadata visually quiet
- Use monospace selectively for indices, dates, and technical metadata
- Keep long-form reading content within the reading width
- Avoid excessive font weights and font-size variants

Do not use gradient text.

Do not use oversized slogans with little informational value.

## 5. Spacing and width

Use the spacing tokens defined in `global.css`.

Current principal widths:

- Page width: `72rem`
- Reading width: `44rem`
- Main narrow-screen breakpoint: `40rem`

Do not introduce arbitrary spacing values when an existing token is suitable.

Large empty areas are acceptable when they create hierarchy and rhythm.
Do not fill whitespace with decorative objects.

## 6. Layout

Use a single primary content column on narrow screens.

Use Grid when the relationship between rows and columns matters.

Use Flexbox for one-dimensional alignment such as navigation, tags, and
horizontal controls.

Prefer content-driven breakpoints. Change the layout when the content begins
to feel crowded, rather than targeting individual device models.

## 7. Components

### Navigation

- Keep navigation visually quiet
- Use `aria-current="page"` for the active page
- Indicate the active page with a restrained underline
- Do not add decorative navigation icons

### Lists

Projects and notes should normally appear as editorial rows separated by
borders.

Do not automatically convert lists into floating cards.

### Tags

Tags are metadata, not primary calls to action.

They should use small type, quiet borders, and restrained spacing.

### Buttons and links

Prefer text links where the action is simple.

Interactive elements must have clear hover and keyboard focus states.

## 8. Motion

Motion is opt-in.

Use animation only when it communicates:

- State
- Hierarchy
- Navigation
- Cause and effect

Do not add:

- Decorative floating motion
- Typewriter effects
- Continuous background animation
- Parallax by default
- Custom cursors

Respect `prefers-reduced-motion` whenever meaningful motion is introduced.

## 9. Accessibility

- Use semantic HTML
- Maintain a logical heading hierarchy
- Provide useful alternative text for meaningful images
- Use `aria-current` for active navigation
- Keep keyboard focus visible
- Maintain sufficient text contrast
- Do not convey meaning through color alone

## 10. Avoid

- Gradient backgrounds or gradient text
- Glassmorphism
- Floating glow objects
- Excessive cards
- Large generic marketing slogans
- Decorative icons without semantic value
- Unnecessary shadows
- Random border radii
- Page-specific design systems
- Client-side JavaScript for static presentation
- Animations without an interaction or state purpose

## 11. Current page language

The shared visual language currently consists of:

- Warm off-white background
- Near-black headings
- Muted supporting copy
- Large tightly spaced page titles
- Thin horizontal dividers
- Restrained tags
- Generous vertical whitespace
- Editorial project and note lists
- Single-column mobile layouts

New pages should extend this language rather than replace it.