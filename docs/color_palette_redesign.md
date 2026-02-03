# Color Palette Redesign

**Status:** RESOLVED. Debate in middle sections; plan at bottom.

---

## Current Inventory

### Named Color Families: 8

| Name | Solarized Hex | OKSolar Hex | Hue Role |
|------|--------------|-------------|----------|
| Yellow | `#b58900` | `#ac8300` | Warning, accent |
| Orange | `#cb4b16` | `#d56500` | Queue/pending |
| Red | `#dc322f` | `#f23749` | Error, destructive |
| Magenta | `#d33682` | `#dd459d` | Loop mode |
| Violet | `#6c71c4` | `#7d80d1` | Primary UI accent |
| Blue | `#268bd2` | `#2b90d8` | User messages |
| Cyan | `#2aa198` | `#259d94` | Assistant, success |
| Green | `#859900` | `#819500` | Status active |

### Variants Per Color: 4

| Variant | Token Pattern | How It's Made | Example (blue) |
|---------|--------------|---------------|----------------|
| dim | `--{color}-dim` | Hand-picked hex | `#1a5f8f` |
| base | `--{color}` | Solarized spec | `#268bd2` |
| bright | `--{color}-bright` | Hand-picked hex | `#4ba3e3` |
| glow | `--{color}-glow` | `rgba(base, 0.22)` | `rgba(38,139,210,0.25)` |

Total accent colors: **8 families x 4 variants = 32**

### Background Elevation Scale: 9 levels

Single-hue ramp. Hue stays near 200° (Solarized base cyan-blue). Only lightness increases:

```
#00141a  L≈8%   darkest
#001e28  L≈12%  base
#002b36  L≈16%  raised-1 (= sol-base03)
#04394a  L≈21%  raised-2
#0a4759  L≈26%  raised-3
#105568  L≈31%  raised-4
#166377  L≈36%  raised-5
#1c7186  L≈41%  raised-6
#228095  L≈46%  highlight
```

This is the best-designed part of the system. It's a controlled lightness ramp on a fixed hue with subtle saturation increase. It's NOT just "add 5 to the lightness" — each step is hand-tuned for perceptual distinctness at the dark end of the spectrum where human vision is worst.

### Text Scale: 5 levels

Drawn from Solarized base tones: base01, base00, base0, base1, plus one custom `#b4bfc0`.

### Borders: 4 levels

All rgba of sol-base1 `(147, 161, 161)` at varying alpha: 10%, 18%, 28%, 42%.

### Message Backgrounds: 4

Hand-picked tinted darks. No derivation relationship to their accent colors.

### Palette Picker: 10 flat `--color-*` variables

Only controls: primary, secondary, accent, background, surface, text, textMuted, border, user, assistant.

### Grand Total: ~99 CSS variables, of which 10 are palette-switchable

---

## How Variants Are Made Today

**They aren't "made." They're typed.** Every single dim, bright, and glow value is a manually chosen hex string. There is no formula, no HSL shift, no `color-mix()`, no computed derivation. If you wanted to add a 9th accent color (say, pink), you'd eyeball four hex values and hope they look right.

The glow variants are the one exception — they're `rgba(base, alpha)` — but even those have inconsistent alpha values (blue is 0.25, everything else is 0.22).

No HSL is used anywhere. No `oklch()`. No `color-mix()`. No `hsl()`. Pure hex.

---

## The OKSolar Question

OKSolar replaces Solarized's accent hex values with perceptually-uniform equivalents. All 8 accents share OKLCh lightness 63.1%, meaning they appear equally bright against any background. Solarized's accents range from L=58 (orange) to L=65 (yellow) — a 12% spread that makes some accents visually louder than others.

OKSolar values:
```
yellow    #ac8300   OKLCh(63.1%, 0.129, 86.4°)
orange    #d56500   OKLCh(63.1%, 0.166, 50.4°)
red       #f23749   OKLCh(63.1%, 0.221, 21.6°)
magenta   #dd459d   OKLCh(63.1%, 0.205, 349.2°)
violet    #7d80d1   OKLCh(63.1%, 0.121, 280.8°)
blue      #2b90d8   OKLCh(63.1%, 0.141, 244.8°)
cyan      #259d94   OKLCh(63.1%, 0.102, 187.2°)
green     #819500   OKLCh(63.1%, 0.148, 118.8°)
```

Base tones also shift slightly. Background hue stays at 219.6° but lightness values are adjusted for better cross-mode consistency.

**The debate starts here: do we just swap hex values, or use this as the forcing function to redesign how colors are stored, derived, and extended?**

---

## DEBATE

### Position A: "Just use CSS `color-mix()` and `oklch()` — no JS, no preprocessor"

Modern CSS can do this natively. Define 8 base accents in oklch, derive everything else:

```css
:root {
  /* Source of truth: 8 accent hues in oklch */
  --accent-blue: oklch(63.1% 0.141 244.8);

  /* Derived — formula, not magic numbers */
  --blue:        var(--accent-blue);
  --blue-dim:    oklch(from var(--accent-blue) calc(l - 0.12) calc(c * 0.8) h);
  --blue-bright: oklch(from var(--accent-blue) calc(l + 0.10) calc(c * 1.1) h);
  --blue-glow:   color-mix(in oklch, var(--accent-blue) 22%, transparent);

  /* Message bg tint: mix accent into background at 8% */
  --bg-user-message: color-mix(in oklch, var(--accent-blue) 8%, var(--bg-content));
}
```

**Strengths:**
- Zero JS. Zero build step. Pure CSS.
- Adding a new accent = 1 line (the base oklch value). The 3 variants derive automatically.
- Palette switching: just change the base oklch values via `setProperty`.
- Browser does the color math in a perceptually uniform space. No hand-eyeballing.
- The bg elevation scale can be formalized the same way: `oklch(from var(--bg-base) calc(l + 0.05 * N) c h)`.

**Weaknesses:**
- `oklch(from ...)` (relative color syntax) is CSS Color Level 5. Safari 16.4+, Chrome 111+, Firefox 128+. No IE. No older browsers.
- Can't compute at build time — if browser doesn't support it, you get raw fallbacks.
- CSS can't loop. You'd still write 8 × 4 = 32 lines. Just with formulas instead of hex.
- Debugging is harder. You can't "see" what `oklch(from var(--accent-blue) calc(l - 0.12) ...)` resolves to in the stylesheet — you have to inspect computed styles.
- Palette picker would need to set values in oklch format. The existing `ColorPalette` type stores hex strings.

---

### Position B: "CSS is a stylesheet, not a programming language. Derive in JS."

Colors are data. Data belongs in code, not in stylesheets. Compute everything in TypeScript, set the full set of ~60 CSS variables via `setProperty`, done.

```typescript
interface PaletteBase {
  // 8 accent hues in OKLCh
  accents: Record<AccentName, { l: number; c: number; h: number }>;
  // Background base in OKLCh
  bgBase: { l: number; c: number; h: number };
  // Text base
  textBase: { l: number; c: number; h: number };
}

function derivePalette(base: PaletteBase): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const [name, { l, c, h }] of Object.entries(base.accents)) {
    vars[`--${name}`]        = oklchToHex(l, c, h);
    vars[`--${name}-dim`]    = oklchToHex(l - 0.12, c * 0.8, h);
    vars[`--${name}-bright`] = oklchToHex(l + 0.10, c * 1.1, h);
    vars[`--${name}-glow`]   = `rgba(${oklchToRgb(l, c, h).join(',')}, 0.22)`;
  }

  // 9-level bg ramp
  for (let i = 0; i < 9; i++) {
    vars[`--bg-raised-${i}`] = oklchToHex(
      base.bgBase.l + (0.05 * i),
      base.bgBase.c + (0.003 * i),
      base.bgBase.h
    );
  }

  return vars; // ~60 variables
}

function applyPalette(base: PaletteBase) {
  const vars = derivePalette(base);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}
```

**Strengths:**
- Full control. Any color math you want. OKLCh, OKLab, deltaE, gamut mapping — whatever.
- Works in every browser (output is hex strings).
- Single source of truth: a `PaletteBase` with ~12 values generates ~60 CSS variables.
- Easy to serialize, store, send over the wire. JSON in, JSON out.
- The AI palette generator already returns JSON. This is the natural fit.
- Can validate at generation time (sRGB gamut check, contrast ratio, etc.).
- Testable. Unit test your color derivation. You can't unit test CSS.

**Weaknesses:**
- Flash of unstyled content. CSS variables are set AFTER React hydration. First paint uses whatever's in the stylesheet.
- Bundle size: an oklch-to-srgb converter is ~2KB but it's another dependency.
- You're fighting the platform. CSS variables exist to hold colors. Making JS the source of truth for styling is architecturally backwards.
- Every time you add a new variant or tweak a formula, it's a code change + rebuild. CSS changes are instant with hot reload.
- Debugging: you can't tweak colors in DevTools and see them update — you'd change the hex, but the JS would overwrite it on next render.

---

### Position C: "Use a CSS preprocessor. Compile once, ship static."

Neither CSS runtime nor JS runtime. Define palettes in SCSS/Less, compile to static CSS at build time. Each palette is a separate CSS file (or `:root` block). No runtime computation.

```scss
// _oksolar-dark.scss
$accents: (
  blue:    (l: 63.1, c: 0.141, h: 244.8),
  cyan:    (l: 63.1, c: 0.102, h: 187.2),
  // ...
);

@each $name, $lch in $accents {
  $base: oklch-to-hex($lch);
  --#{$name}:        #{$base};
  --#{$name}-dim:    #{oklch-to-hex(dim($lch))};
  --#{$name}-bright: #{oklch-to-hex(bright($lch))};
  --#{$name}-glow:   #{rgba(oklch-to-rgb($lch), 0.22)};
}
```

**Strengths:**
- Zero runtime cost. Ship static CSS with pre-computed hex.
- Loops, functions, mixins — a preprocessor IS a programming language for CSS.
- No browser compatibility concerns. Output is plain hex.
- No FOUC. Colors are in the stylesheet from first paint.

**Weaknesses:**
- Sass doesn't have oklch functions. You'd need a custom Sass plugin or a Node script that generates the SCSS variables first. So it's really "JS that generates SCSS that generates CSS" — two build steps for what?
- **Kills runtime palette switching.** If palettes are compiled to static CSS, switching means loading a different stylesheet. The current "preview on hover" UX becomes a network request per palette.
- AI-generated custom palettes can't work at all — you'd need to compile a new CSS file on the server for each generated palette.
- Adds a build dependency (Sass) to a project that currently uses plain CSS.
- We're adding complexity to avoid complexity.

---

### Position D: "The bg elevation scale is the real pattern. Generalize it."

Forget the 4-variant model (dim/base/bright/glow). Look at what actually works: the background elevation scale. It's a single-hue lightness ramp with 9 levels. The reason it works is that it's not "4 arbitrary variants" — it's a continuous scale where each level has a clear semantic meaning (page < content < card < panel < hover < active < popup).

Apply the same pattern to every accent:

```
--blue-1:  (very dark, for message backgrounds)
--blue-2:  (dark, for subtle tints)
--blue-3:  (dim, for inactive/disabled)
--blue-4:  (base, the "normal" accent)
--blue-5:  (bright, for hover)
--blue-6:  (vivid, for active/focus)
--blue-7:  (light, for badges/text on dark bg)
--blue-8:  (pastel, for light-mode backgrounds)
--blue-9:  (near-white, for light-mode highlights)
```

That's 8 accents × 9 levels = 72 accent colors. Plus the 9-level bg scale. Plus borders, text, etc. Maybe ~100 total.

**Strengths:**
- Consistent scale across all accents. "Level 3" means the same thing whether it's blue-3 or red-3.
- Message backgrounds (`--bg-user-message`) are just `--blue-1` or `--cyan-1`. No separate hand-picked tints.
- The dim/bright/glow naming is arbitrary. A numbered scale has a clear ordering.
- Scales compose: "I need a slightly lighter blue" → go up one level. No guessing hex values.
- With oklch derivation, 72 colors = 8 base values + a formula. Not 72 hand-picked hexes.

**Weaknesses:**
- 72 accent variables is a lot. Most will never be used.
- Naming: `--blue-4` means nothing to a new developer. `--blue-dim` at least says what it's for.
- Over-engineering. We use exactly 4 variants per accent today (dim, base, bright, glow). Jumping to 9 is solving a problem we don't have.
- The bg scale works because it maps to spatial metaphors (elevation, layering). Accent scales don't have that natural mapping. What does "blue level 6" mean in UI terms?

**Counter-counter:** The 9 levels aren't all named. Only the ones we use get semantic aliases:
```css
--blue-tint:    var(--blue-1);  /* message backgrounds */
--blue-dim:     var(--blue-3);  /* disabled */
--blue:         var(--blue-4);  /* base */
--blue-bright:  var(--blue-6);  /* hover */
--blue-glow:    color-mix(in srgb, var(--blue-4) 22%, transparent);
```
The scale exists for interpolation. You don't name every point on a gradient.

---

### Position E: "You're all overthinking this. The problem is the palette picker, not the color system."

The color system is fine. 99 variables, hand-picked, works today. The actual problem is that switching palettes only touches 10 of those 99 variables, so palette switching is cosmetic.

Fix: make `applyPalette()` set ALL the semantic variables, not just 10. Expand `ColorPalette` to include every accent:

```typescript
interface ColorPalette {
  name: string;
  base: {
    background: string;    // → --bg-base
    surface: string;       // → --bg-raised-3
    text: string;          // → --text-primary
    textMuted: string;     // → --text-muted
    border: string;        // → --border-color
  };
  accents: {
    blue: string;          // → --blue, then derive dim/bright/glow in JS
    cyan: string;
    violet: string;
    green: string;
    yellow: string;
    orange: string;
    red: string;
    magenta: string;
  };
  semantic: {
    user: string;          // accent name, e.g. "blue"
    assistant: string;     // accent name, e.g. "cyan"
    primary: string;       // accent name, e.g. "violet"
    error: string;         // accent name, e.g. "red"
    warning: string;       // accent name, e.g. "yellow"
    queue: string;         // accent name, e.g. "orange"
    loop: string;          // accent name, e.g. "magenta"
    success: string;       // accent name, e.g. "cyan"
  };
}
```

Then `applyPalette()` takes these ~21 values and computes the full ~60 derived variables (dim/bright/glow, bg elevation, message tints, borders). JS derivation because the palette data is already in JS.

**Strengths:**
- Minimal change to CSS. Keep all the existing variable names. Just change how they're populated.
- The AI generator now specifies 8 accent hex values instead of trying to generate dim/bright/glow variants too.
- Adding OKSolar is just another `ColorPalette` object with different hex values.
- Semantic mapping (which accent is "user", which is "error") is part of the palette definition, so themes can remap them.

**Weaknesses:**
- Still JS-derived. Still FOUC risk.
- Still hand-picked hex for the 8 base accents. The dim/bright/glow are derived, but the source accents are still "someone picked a hex."
- Doesn't solve the "how are variants computed" question — it just moves it into `applyPalette()`.

---

### Position F: "Store OKLCh, not hex. Make the colorspace the source of truth."

Every previous position still stores hex or RGB at some point. This is wrong. Hex is an output format for sRGB displays, not a storage format for design intent. If you store `#268bd2`, you've lost the perceptual information. You can't answer "make this 10% lighter" without converting to a perceptual space first.

Store OKLCh tuples. Always. Everywhere. Convert to hex/rgb at the boundary (CSS output, canvas rendering).

```typescript
// The ONLY source of truth
const OKSOLAR: PaletteSource = {
  name: 'OKSolar Dark',
  bgHue: 219.6,
  bgChroma: 0.05,
  bgLightness: [0.274, 0.321],  // base03, base02
  textLightness: [0.535, 0.544, 0.718, 0.718],  // muted, secondary, primary, emphasis
  textChroma: [0.029, 0.017, 0.017, 0.030],
  textHue: [219.6, 219.6, 198, 198],
  accentLightness: 0.631,  // ALL accents at equal perceptual lightness
  accents: {
    yellow:  { c: 0.129, h: 86.4 },
    orange:  { c: 0.166, h: 50.4 },
    red:     { c: 0.221, h: 21.6 },
    magenta: { c: 0.205, h: 349.2 },
    violet:  { c: 0.121, h: 280.8 },
    blue:    { c: 0.141, h: 244.8 },
    cyan:    { c: 0.102, h: 187.2 },
    green:   { c: 0.148, h: 118.8 },
  },
};
```

Now derivation is trivial:
```typescript
function dim(l: number, c: number, h: number) {
  return { l: l - 0.12, c: c * 0.75, h };
}
function bright(l: number, c: number, h: number) {
  return { l: l + 0.10, c: c * 1.15, h };
}
function bgLevel(base: OKLCh, level: number) {
  return { l: base.l + (0.047 * level), c: base.c + (0.003 * level), h: base.h };
}
```

**Strengths:**
- Perceptual operations are trivial. "10% lighter" = `l + 0.1`. No hex conversion dance.
- OKSolar and Solarized are the same structure with different numbers.
- Hue customization is a 1-number change (OKSolar article shows base hue variants).
- The AI palette generator can work in OKLCh directly — specify lightness and chroma constraints, vary hue.
- Gamut checking is meaningful: you can verify sRGB representability before converting.
- Cross-palette consistency: all palettes guarantee equal accent lightness if they share `accentLightness`.

**Weaknesses:**
- Third-party palettes (Nord, Dracula, etc.) aren't designed in OKLCh. You'd reverse-engineer their OKLCh values, which is lossy and defeats the purpose.
- Over-abstraction for a chat UI. We're not building a design system for 50 products. We have one dark theme.
- Bundle cost: oklch conversion math isn't zero.
- You can't copy-paste a hex value from Figma anymore. Every color goes through a conversion pipeline.
- The whole point of named palettes (Dracula, Nord) is their specific hex values, hand-tuned by designers. Deconstructing them into OKLCh components then re-deriving hex may produce subtly different values. Dracula's purple is `#bd93f9` because a human decided it looks good, not because it's at oklch lightness 0.63.

---

## The Background Ramp Question

The user mentioned the bg elevation scale and asked if we should extend this pattern. Let's examine what it actually is:

```
Level   Hex       OKLCh L    OKLCh C    OKLCh H
darkest #00141a   0.145      0.028      219.6
base    #001e28   0.184      0.037      219.6
raised1 #002b36   0.226      0.047      219.6  (= sol-base03)
raised2 #04394a   0.268      0.052      214.8
raised3 #0a4759   0.310      0.054      210.4
raised4 #105568   0.352      0.055      207.5
raised5 #166377   0.394      0.055      205.3
raised6 #1c7186   0.434      0.056      203.6
highlt  #228095   0.474      0.056      201.9
```

**What's happening:**
- Lightness increases ~0.04 per step (roughly linear)
- Chroma increases slightly then plateaus
- Hue drifts from 219° toward 202° (gets less green, more pure blue)

This is a designed ramp, not a mathematical one. The hue drift is perceptual compensation — at higher lightness, the same hue looks different, so it's adjusted to maintain visual consistency.

**Could this be formalized?** Sort of. The lightness is approximately `0.145 + (0.041 * level)`. The chroma is approximately `min(0.028 + (0.005 * level), 0.056)`. The hue is approximately `219.6 - (2.2 * level)`. But these are curve-fits, not the original design intent.

**Should accent colors have the same ramp?** This is the Position D argument. It's compelling for accents that need tints (message backgrounds, hover states). But 9 levels per accent when we use 3-4 is wasteful.

**Compromise:** 5 levels per accent, derived from base:
```
level 1: message background tint (L = bgBase.l + 0.03, C = accentBase.c * 0.15)
level 2: dim (L = accentBase.l - 0.12, C *= 0.75)
level 3: base (= the accent)
level 4: bright (L += 0.10, C *= 1.15)
level 5: pastel (L += 0.25, C *= 0.5)  — for light mode / badges
```

---

## Unresolved Questions

1. **CSS `oklch()` or JS conversion?** CSS is cleaner but requires relative color syntax support. JS works everywhere but has FOUC.

2. **How many variants per accent?** Current: 4 (dim/base/bright/glow). Proposed range: 4-9. More levels = more flexibility but more naming/cognitive overhead.

3. **Should the palette picker control individual accent hues?** Currently it sets 10 flat colors. If it set 8 accent hues + bg/text, the full system derives from that. But then third-party palettes (Nord, Dracula) need decomposition into this format.

4. **Is OKLCh the right storage format?** For Solarized/OKSolar variants, yes. For importing arbitrary third-party palettes, it adds a lossy conversion step.

5. **Do we compile (preprocessor), compute at runtime (JS), or let the browser compute (CSS)?** Each has real trade-offs. Preprocessor kills runtime switching. JS has FOUC. CSS has browser support gaps.

6. **Is the bg elevation scale a generalizable pattern or a one-off?** It works for backgrounds because "higher = lighter = more elevated" is a natural metaphor. Accent scales lack this spatial metaphor.

7. **How do AI-generated palettes fit?** They return JSON. If the source of truth is OKLCh, the AI prompt should specify OKLCh constraints. If it's hex, the prompt is simpler but we lose perceptual guarantees.

8. **What about the 48+ hardcoded colors in component CSS?** Any redesign that doesn't also eliminate these is theater. The prettiest color system in `index.css` doesn't matter if `PromptPalette.css` hardcodes `#2a2a2a`.

---

## What OKSolar Specifically Needs

Regardless of which position wins, adding OKSolar requires:

1. The 8 accent hex values (listed above)
2. The 8 base tone hex values:
   ```
   base03: #002d38    base02: #093946
   base01: #5b7279    base00: #657377
   base0:  #98a8a8    base1:  #8faaab
   base2:  #f1e9d2    base3:  #fbf7ef
   ```
3. Re-derived dim/bright/glow for each accent (4 × 8 = 32 values)
4. Re-derived bg elevation scale (9 values, using base03 as the anchor)
5. Re-derived message background tints (4 values)
6. Re-derived text scale (5 values from the base tones)
7. Re-derived border scale (4 values using base1 as the source)

That's ~72 values to compute or hand-pick. Under the current system (hand-picked hex), that's 72 magic numbers. Under any derivation system, it's 16 base values + formulas.

This is the strongest argument for derivation: OKSolar is the second palette that needs the full treatment, and we'll add more. Typing 72 hex values per palette doesn't scale.

---

## RESOLUTION

### Decisions

| Question | Decision | Why |
|----------|----------|-----|
| CSS vs JS vs preprocessor? | **CSS derivation** (color-mix + oklch) with **JS setting base tokens** | We need runtime switching. CSS derives. JS populates. No preprocessor. |
| How many layers? | **2** (palette tokens → derived/semantic) | Kill the 4-layer indirection. `--sol-*` and `--color-*` merge into palette tokens. |
| How many base tokens? | **16** (8 base tones + 8 accents) | Matches Solarized/OKSolar structure. Third-party palettes map into same 16 slots. |
| How many variants per accent? | **4** (dim / base / bright / glow) | Derived via `color-mix()`. Current usage doesn't need more. Add levels later if needed. |
| Storage format? | **Hex in JSON/TS** | Hex is portable, tool-friendly, copy-pasteable. OKLCh metadata is nice-to-have, not required. |
| Where does derivation happen? | **CSS** via `color-mix(in oklch, ...)` | Browser computes. No JS color math. No bundle dependency. |
| Bg elevation scale? | **Derived from palette bg token** via `color-mix()` | No more 9 hand-picked hex values per palette. |
| Message bg tints? | **Derived** `color-mix(in oklch, accent 8%, bg-content)` | Follows accent color when palette changes. |
| Third-party palettes? | **Map into 16 slots** | Nord bg → base03/02 slots, Nord text → base0/1 slots, Nord accents → 8 accent slots. Lossy but practical. |
| AI generation? | **Claude outputs 16 hex values** | Server validates, client applies. Derivation happens in CSS, not in Claude's output. |
| OKSolar? | **Just another palette entry** | Same 16 slots, different hex values. |

### Architecture: Two Layers

```
PALETTE TOKENS (16, set by JS)          DERIVED + SEMANTIC (60+, CSS computes)
─────────────────────────────           ────────────────────────────────────────
--pal-base03  (darkest bg)         ──>  --bg-darkest, --bg-base, --bg-content,
--pal-base02  (surface bg)              --bg-card, --bg-panel, --bg-hover, ...
--pal-base01  (muted text)         ──>  --text-muted
--pal-base00  (secondary text)     ──>  --text-secondary
--pal-base0   (body text)          ──>  --text-primary
--pal-base1   (emphasis text)      ──>  --text-emphasis, --text-on-accent
--pal-blue    (accent)             ──>  --blue, --blue-dim, --blue-bright, --blue-glow
--pal-cyan    ...                       --accent-user, --accent-assistant, ...
--pal-violet  ...                       --accent-primary, --accent-primary-hover
--pal-green   ...                       --bg-user-message, --bg-assistant-message, ...
--pal-yellow  ...                       --border-subtle, --border-default, ...
--pal-orange  ...
--pal-red     ...
--pal-magenta ...
```

**Rule:** Component CSS references ONLY derived/semantic tokens. Never `--pal-*` directly.

### CSS Implementation

```css
:root {
  /* ═══════════════════════════════════════════════════
     PALETTE TOKENS — the only values applyPalette() sets.
     Default: Solarized Dark. OKSolar, Nord, etc. override these.
     ═══════════════════════════════════════════════════ */
  --pal-base03: #002b36;
  --pal-base02: #073642;
  --pal-base01: #586e75;
  --pal-base00: #657b83;
  --pal-base0:  #839496;
  --pal-base1:  #93a1a1;
  --pal-yellow:  #b58900;
  --pal-orange:  #cb4b16;
  --pal-red:     #dc322f;
  --pal-magenta: #d33682;
  --pal-violet:  #6c71c4;
  --pal-blue:    #268bd2;
  --pal-cyan:    #2aa198;
  --pal-green:   #859900;

  /* ═══════════════════════════════════════════════════
     DERIVED: Background elevation scale
     9 levels from palette bg, using color-mix lightening.
     Each step mixes more white into the base background.
     ═══════════════════════════════════════════════════ */
  --bg-darkest:   color-mix(in oklch, var(--pal-base03) 70%, black);
  --bg-base:      color-mix(in oklch, var(--pal-base03) 85%, black);
  --bg-content:   var(--pal-base03);
  --bg-card:      color-mix(in oklch, var(--pal-base03) 85%, var(--pal-base02));
  --bg-sidebar:   color-mix(in oklch, var(--pal-base03) 92%, black);
  --bg-panel:     var(--pal-base02);
  --bg-hover:     color-mix(in oklch, var(--pal-base02) 80%, var(--pal-base01));
  --bg-active:    color-mix(in oklch, var(--pal-base02) 65%, var(--pal-base01));
  --bg-popup:     color-mix(in oklch, var(--pal-base02) 50%, var(--pal-base01));
  --bg-highlight: color-mix(in oklch, var(--pal-base02) 35%, var(--pal-base01));

  /* ═══════════════════════════════════════════════════
     DERIVED: Text scale
     ═══════════════════════════════════════════════════ */
  --text-muted:     var(--pal-base01);
  --text-secondary: var(--pal-base00);
  --text-primary:   var(--pal-base0);
  --text-emphasis:  var(--pal-base1);
  --text-bright:    color-mix(in oklch, var(--pal-base1) 70%, white);
  --text-on-accent: color-mix(in oklch, var(--pal-base03) 90%, black);

  /* ═══════════════════════════════════════════════════
     DERIVED: Borders (from base1 at varying alpha)
     ═══════════════════════════════════════════════════ */
  --border-subtle:   color-mix(in srgb, var(--pal-base1) 10%, transparent);
  --border-default:  color-mix(in srgb, var(--pal-base1) 18%, transparent);
  --border-emphasis: color-mix(in srgb, var(--pal-base1) 28%, transparent);
  --border-strong:   color-mix(in srgb, var(--pal-base1) 42%, transparent);
  --border-color:    var(--bg-panel);

  /* ═══════════════════════════════════════════════════
     DERIVED: Accent families — each has dim/base/bright/glow
     Formula: dim=65% toward black, bright=75% toward white,
     glow=22% alpha overlay.
     ═══════════════════════════════════════════════════ */
  --blue:        var(--pal-blue);
  --blue-dim:    color-mix(in oklch, var(--pal-blue) 65%, black);
  --blue-bright: color-mix(in oklch, var(--pal-blue) 75%, white);
  --blue-glow:   color-mix(in srgb, var(--pal-blue) 22%, transparent);

  --cyan:        var(--pal-cyan);
  --cyan-dim:    color-mix(in oklch, var(--pal-cyan) 65%, black);
  --cyan-bright: color-mix(in oklch, var(--pal-cyan) 75%, white);
  --cyan-glow:   color-mix(in srgb, var(--pal-cyan) 22%, transparent);

  /* ... same pattern for violet, green, yellow, orange, red, magenta ... */

  /* ═══════════════════════════════════════════════════
     DERIVED: Semantic accent mappings
     ═══════════════════════════════════════════════════ */
  --accent-primary:       var(--violet);
  --accent-primary-hover: var(--violet-bright);
  --accent-user:          var(--blue);
  --accent-assistant:     var(--cyan);
  --accent-success:       var(--cyan);
  --accent-warning:       var(--yellow);
  --accent-error:         var(--red);
  --accent-queue:         var(--orange);
  --accent-loop:          var(--magenta);

  /* ═══════════════════════════════════════════════════
     DERIVED: Message backgrounds — tint of accent into bg
     ═══════════════════════════════════════════════════ */
  --bg-user-message:      color-mix(in oklch, var(--accent-user) 8%, var(--bg-content));
  --bg-assistant-message: color-mix(in oklch, var(--accent-assistant) 8%, var(--bg-content));
  --bg-system-message:    color-mix(in oklch, var(--accent-warning) 8%, var(--bg-content));
  --bg-error-message:     color-mix(in oklch, var(--accent-error) 8%, var(--bg-content));
}
```

### TypeScript: New Palette Type

```typescript
/**
 * 16-token palette. The only source of truth for a theme.
 * CSS derives all other tokens (~60+) from these via color-mix().
 *
 * Naming follows Solarized convention (base03-base1 + 8 accents)
 * but any palette can map into these slots:
 *   base03 = darkest background
 *   base02 = surface/raised background
 *   base01 = muted text / comments
 *   base00 = secondary text
 *   base0  = primary text
 *   base1  = emphasized text
 *   8 accents = yellow, orange, red, magenta, violet, blue, cyan, green
 */
interface Palette16 {
  name: string;
  base03: string;  // darkest bg
  base02: string;  // surface bg
  base01: string;  // muted text
  base00: string;  // secondary text
  base0:  string;  // primary text
  base1:  string;  // emphasis text
  yellow:  string;
  orange:  string;
  red:     string;
  magenta: string;
  violet:  string;
  blue:    string;
  cyan:    string;
  green:   string;
}
```

### Built-In Palettes

```typescript
const PALETTES: Record<string, Palette16> = {
  solarized: {
    name: 'Solarized Dark',
    base03: '#002b36', base02: '#073642',
    base01: '#586e75', base00: '#657b83',
    base0:  '#839496', base1:  '#93a1a1',
    yellow: '#b58900', orange: '#cb4b16',
    red:    '#dc322f', magenta:'#d33682',
    violet: '#6c71c4', blue:   '#268bd2',
    cyan:   '#2aa198', green:  '#859900',
  },
  oksolar: {
    name: 'OKSolar Dark',
    base03: '#002d38', base02: '#093946',
    base01: '#5b7279', base00: '#657377',
    base0:  '#98a8a8', base1:  '#8faaab',
    yellow: '#ac8300', orange: '#d56500',
    red:    '#f23749', magenta:'#dd459d',
    violet: '#7d80d1', blue:   '#2b90d8',
    cyan:   '#259d94', green:  '#819500',
  },
  nord: {
    name: 'Nord',
    base03: '#2e3440', base02: '#3b4252',
    base01: '#d8dee9', base00: '#e5e9f0',  // Nord text is light
    base0:  '#eceff4', base1:  '#eceff4',
    yellow: '#ebcb8b', orange: '#d08770',
    red:    '#bf616a', magenta:'#b48ead',
    violet: '#b48ead', blue:   '#81a1c1',
    cyan:   '#88c0d0', green:  '#a3be8c',
  },
  dracula: {
    name: 'Dracula',
    base03: '#282a36', base02: '#44475a',
    base01: '#6272a4', base00: '#f8f8f2',
    base0:  '#f8f8f2', base1:  '#f8f8f2',
    yellow: '#f1fa8c', orange: '#ffb86c',
    red:    '#ff5555', magenta:'#ff79c6',
    violet: '#bd93f9', blue:   '#8be9fd',
    cyan:   '#8be9fd', green:  '#50fa7b',
  },
  // ... monokai, gruvbox, tokyo, catppuccin mapped similarly
};
```

### applyPalette() — Sets 14 CSS Variables

```typescript
function applyPalette(palette: Palette16) {
  const root = document.documentElement;
  const entries: [string, string][] = [
    ['--pal-base03', palette.base03],
    ['--pal-base02', palette.base02],
    ['--pal-base01', palette.base01],
    ['--pal-base00', palette.base00],
    ['--pal-base0',  palette.base0],
    ['--pal-base1',  palette.base1],
    ['--pal-yellow',  palette.yellow],
    ['--pal-orange',  palette.orange],
    ['--pal-red',     palette.red],
    ['--pal-magenta', palette.magenta],
    ['--pal-violet',  palette.violet],
    ['--pal-blue',    palette.blue],
    ['--pal-cyan',    palette.cyan],
    ['--pal-green',   palette.green],
  ];
  for (const [key, value] of entries) {
    root.style.setProperty(key, value);
  }
  // CSS color-mix() derives the other ~60 variables automatically
}
```

14 setProperty calls. CSS does the rest. No oklch conversion library. No FOUC for default theme (values are in the stylesheet). Palette switches are instant.

### AI Generation Contract

**Server endpoint:** `POST /api/generate-palette`

**Request:**
```json
{
  "description": "warm desert sunset, high contrast, sand and terracotta",
  "provider": "claude"
}
```

**Claude prompt constraint:**
```
Return ONLY a JSON object with exactly these 14 keys.
All values must be valid #RRGGBB hex.
base03 must be the darkest. base1 must be the lightest of the base tones.
The 8 accent colors should be visually distinct from each other.
Accent colors should have good contrast (WCAG AA) against base03 background.
```

**Server validation before returning to client:**
1. All 14 keys present, valid hex
2. Monotonic luminance: base03 < base02 < base01 < base00 < base0 <= base1
3. Min contrast ratio: each accent vs base03 >= 4.5:1 (WCAG AA)
4. No duplicate colors
5. Accent deltaE (in oklch) between any two accents >= 15 (perceptually distinct)

**Response:**
```json
{
  "key": "custom_3",
  "palette": {
    "name": "Desert Sunset",
    "base03": "#1a1008", "base02": "#2d2013",
    "base01": "#7a6b55", "base00": "#8e7f69",
    "base0":  "#a89880", "base1":  "#c4b69e",
    "yellow": "#d4a030", "orange": "#c85a20",
    "red":    "#b83030", "magenta":"#a04878",
    "violet": "#7868a8", "blue":   "#4888b8",
    "cyan":   "#389088", "green":  "#688830"
  }
}
```

### Hardcoded Color Elimination

Every hardcoded hex/rgba in component CSS must be replaced.

| Current | Replacement |
|---------|-------------|
| `#fff` (button text) | `var(--text-on-accent)` |
| `#c9302c` (darker red hover) | `var(--red-dim)` |
| `#dc3545` (error text) | `var(--accent-error)` |
| `rgba(203, 75, 22, 0.1)` | `color-mix(in srgb, var(--orange) 10%, transparent)` |
| `rgba(42, 161, 152, 0.35)` | `color-mix(in srgb, var(--cyan) 35%, transparent)` |
| `rgba(147, 161, 161, 0.3)` | `var(--border-emphasis)` or `color-mix(in srgb, var(--pal-base1) 30%, transparent)` |
| `rgba(0, 0, 0, 0.2-0.6)` | `color-mix(in srgb, black N%, transparent)` — these are fine, black doesn't change with palette |
| PromptPalette.css `#2a2a2a` etc. | `var(--bg-panel)`, `var(--bg-hover)`, `var(--text-primary)`, etc. |

### Implementation Steps

**Step 1: Rename palette tokens in index.css**
- `--sol-base03` → `--pal-base03`, `--sol-blue` → `--pal-blue`, etc.
- Find/replace across all CSS files

**Step 2: Replace hand-picked accent families with color-mix()**
- Remove 24 hand-picked dim/bright hex values
- Replace with `color-mix(in oklch, ...)` formulas
- Keep glow as `color-mix(in srgb, ... 22%, transparent)`

**Step 3: Replace hand-picked bg elevation scale with color-mix()**
- Remove 9 hand-picked hex values
- Replace with `color-mix()` interpolations between palette base tones

**Step 4: Derive message backgrounds from accents**
- `--bg-user-message: color-mix(in oklch, var(--accent-user) 8%, var(--bg-content))`

**Step 5: Derive borders from base1**
- `--border-subtle: color-mix(in srgb, var(--pal-base1) 10%, transparent)`

**Step 6: Add --text-on-accent**

**Step 7: Kill --color-* layer**
- Remove all 10 `--color-*` variables
- Update ConfigDropdown.css and ColorPalettePicker.css to use semantic tokens
- Remove fallback hex values from `var(--color-*, #hex)` patterns

**Step 8: Replace all hardcoded colors in component CSS**
- PromptPalette.css (full rewrite to use vars)
- Chat.css, Sidebar.css, Gallery.css (replace individual hardcoded values)

**Step 9: Update Palette16 type + applyPalette()**
- Replace `ColorPalette` with `Palette16`
- `applyPalette()` sets 14 `--pal-*` CSS variables
- Map existing third-party palettes (Nord, Dracula, etc.) into Palette16 format

**Step 10: Add OKSolar palette**
- Just another `Palette16` entry in the PALETTES record

**Step 11: Update AI palette generation**
- Prompt asks for 14 values (Palette16 shape)
- Server validates contrast, monotonicity, deltaE
- Client applies via same applyPalette()

### Verification

After implementation:
1. `pnpm build` — zero errors
2. Default Solarized looks identical to before (visual regression check)
3. Switch to OKSolar — entire UI re-themes, including:
   - Message backgrounds tint to match new accent colors
   - Dim/bright variants follow new accents
   - Background elevation scale adjusts to new base03/base02
4. Switch to Nord — entire UI re-themes
5. Switch back to Solarized — correct restoration
6. AI-generate a palette — validates, applies, persists
7. No hardcoded hex visible in any component CSS file (grep confirms)
8. PromptPalette looks correct under all palettes

### Browser Support

`color-mix()` support:
- Chrome 111+ (March 2023)
- Safari 16.4+ (March 2023)
- Firefox 113+ (May 2023)

This is a Vite dev-tool app, not a public website. These targets are fine.
