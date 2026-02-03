# Color System Reference

## Architecture

Two layers. No more, no less.

```
PALETTE TOKENS (14, set by JS)     →     DERIVED + SEMANTIC (~60, CSS computes via color-mix)
--pal-base03, --pal-blue, ...             --bg-card, --blue-dim, --accent-user, ...
```

**Components use ONLY derived/semantic tokens.** Never `--pal-*` directly.

See `docs/color_palette_redesign.md` for the full debate, rationale, and implementation plan.

---

## Palette Tokens (14 values per theme)

These are the ONLY values `applyPalette()` sets. CSS derives everything else.

| Token | Solarized | OKSolar | Slot Purpose |
|-------|-----------|---------|-------------|
| `--pal-base03` | `#002b36` | `#002d38` | Darkest background |
| `--pal-base02` | `#073642` | `#093946` | Surface / raised bg |
| `--pal-base01` | `#586e75` | `#5b7279` | Muted text |
| `--pal-base00` | `#657b83` | `#657377` | Secondary text |
| `--pal-base0` | `#839496` | `#98a8a8` | Primary text |
| `--pal-base1` | `#93a1a1` | `#8faaab` | Emphasis text |
| `--pal-yellow` | `#b58900` | `#ac8300` | Accent: warning |
| `--pal-orange` | `#cb4b16` | `#d56500` | Accent: queue/pending |
| `--pal-red` | `#dc322f` | `#f23749` | Accent: error |
| `--pal-magenta` | `#d33682` | `#dd459d` | Accent: loop |
| `--pal-violet` | `#6c71c4` | `#7d80d1` | Accent: primary UI |
| `--pal-blue` | `#268bd2` | `#2b90d8` | Accent: user |
| `--pal-cyan` | `#2aa198` | `#259d94` | Accent: assistant |
| `--pal-green` | `#859900` | `#819500` | Accent: success/active |

### OKSolar Difference

OKSolar normalizes all 8 accent colors to equal OKLCh lightness (63.1%). Solarized accents range from L=58 (orange) to L=65 (yellow), causing uneven perceived brightness. OKSolar fixes this while preserving hues.

---

## Derived Tokens (CSS computes these)

### Accent Families: 4 variants per color

| Variant | CSS Formula | Purpose |
|---------|------------|---------|
| `--{color}` | `var(--pal-{color})` | Base accent |
| `--{color}-dim` | `color-mix(in oklch, var(--pal-{color}) 65%, black)` | Disabled, subtle |
| `--{color}-bright` | `color-mix(in oklch, var(--pal-{color}) 75%, white)` | Hover, emphasis |
| `--{color}-glow` | `color-mix(in srgb, var(--pal-{color}) 22%, transparent)` | Glow/halo overlay |

8 colors x 4 variants = 32 derived accent tokens.

### Background Elevation

Derived from `--pal-base03` and `--pal-base02` via `color-mix()`:

| Token | Semantic Use |
|-------|-------------|
| `--bg-darkest` | Overlay backdrop |
| `--bg-base` | Page background |
| `--bg-content` | Content area (= base03) |
| `--bg-card` | Cards, list items |
| `--bg-sidebar` | Sidebar |
| `--bg-panel` | Panels (= base02) |
| `--bg-hover` | Hover states |
| `--bg-active` | Active/selected |
| `--bg-popup` | Popups, dropdowns |
| `--bg-highlight` | Focus rings |

### Text Scale

| Token | Source |
|-------|--------|
| `--text-muted` | `var(--pal-base01)` |
| `--text-secondary` | `var(--pal-base00)` |
| `--text-primary` | `var(--pal-base0)` |
| `--text-emphasis` | `var(--pal-base1)` |
| `--text-bright` | `color-mix(in oklch, var(--pal-base1) 70%, white)` |
| `--text-on-accent` | `color-mix(in oklch, var(--pal-base03) 90%, black)` |

### Borders

All derived from `--pal-base1` at varying alpha via `color-mix(in srgb, ... N%, transparent)`.

### Message Backgrounds

Derived from accent + background: `color-mix(in oklch, accent 8%, bg-content)`.

### Semantic Accent Mappings

| Token | Maps To | Purpose |
|-------|---------|---------|
| `--accent-primary` | `var(--violet)` | Buttons, focus |
| `--accent-primary-hover` | `var(--violet-bright)` | Button hover |
| `--accent-user` | `var(--blue)` | User messages |
| `--accent-assistant` | `var(--cyan)` | Assistant messages |
| `--accent-success` | `var(--cyan)` | Success states |
| `--accent-warning` | `var(--yellow)` | Warnings |
| `--accent-error` | `var(--red)` | Errors |
| `--accent-queue` | `var(--orange)` | Queue/pending |
| `--accent-loop` | `var(--magenta)` | Loop mode |

---

## Rules

1. **No hardcoded hex in component CSS.** Use variables. Always.
2. **Components use semantic tokens**, not palette tokens. `var(--accent-error)`, not `var(--pal-red)`.
3. **For alpha/tint overlays**, use `color-mix(in srgb, var(--color) N%, transparent)`. Never `rgba(R,G,B,a)` with magic numbers.
4. **Text on colored backgrounds** uses `var(--text-on-accent)`, not `#fff`.
5. **Adding a new palette:** Create a `Palette16` object with 14 hex values. CSS derives the rest.
6. **Adding a new accent:** Add `--pal-{name}` token + 4 `color-mix()` derivations in `:root`. Map it to a `--accent-*` semantic token.

---

## AI Palette Generation

`POST /api/generate-palette` with `{ description: string }`.

Claude returns 14 hex values matching the `Palette16` shape. Server validates:
- All keys present, valid `#RRGGBB`
- Base ramp is monotonic (base03 darkest, base1 lightest)
- Accent contrast vs base03 >= 4.5:1 (WCAG AA)
- No duplicate colors
- Accents perceptually distinct (deltaE >= 15)

Client applies via `applyPalette()`. CSS derives the full system.

---

## Token Count

| Category | Count | How |
|----------|-------|-----|
| Palette tokens | 14 | Set by JS |
| Accent families | 32 | CSS `color-mix()` from palette |
| Background scale | 10 | CSS `color-mix()` from palette |
| Text scale | 6 | Direct + CSS `color-mix()` |
| Borders | 5 | CSS `color-mix()` from palette |
| Semantic accents | 9 | CSS `var()` aliases |
| Message backgrounds | 4 | CSS `color-mix()` from accents |
| Code styling | 3 | CSS `var()` aliases |
| **Total** | **~83** | **14 set, ~69 derived** |
