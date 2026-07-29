---
name: Charcoal & Ivory Monochrome
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#3a3939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#c4c7c8'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#8e9192'
  outline-variant: '#444748'
  surface-tint: '#c6c6c7'
  primary: '#ffffff'
  on-primary: '#2f3131'
  primary-container: '#e2e2e2'
  on-primary-container: '#636565'
  inverse-primary: '#5d5f5f'
  secondary: '#c8c6c6'
  on-secondary: '#303030'
  secondary-container: '#474747'
  on-secondary-container: '#b6b5b4'
  tertiary: '#ffffff'
  on-tertiary: '#303031'
  tertiary-container: '#e3e2e2'
  on-tertiary-container: '#646464'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e2e2e2'
  primary-fixed-dim: '#c6c6c7'
  on-primary-fixed: '#1a1c1c'
  on-primary-fixed-variant: '#454747'
  secondary-fixed: '#e4e2e1'
  secondary-fixed-dim: '#c8c6c6'
  on-secondary-fixed: '#1b1c1c'
  on-secondary-fixed-variant: '#474747'
  tertiary-fixed: '#e3e2e2'
  tertiary-fixed-dim: '#c7c6c6'
  on-tertiary-fixed: '#1b1c1c'
  on-tertiary-fixed-variant: '#464747'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  display:
    fontFamily: JetBrains Mono
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: JetBrains Mono
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-lg-mobile:
    fontFamily: JetBrains Mono
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-md:
    fontFamily: JetBrains Mono
    fontSize: 24px
    fontWeight: '500'
    lineHeight: '1.3'
  body-lg:
    fontFamily: JetBrains Mono
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: JetBrains Mono
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.4'
    letterSpacing: 0.02em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1.4'
    letterSpacing: 0.05em
rounded:
  sm: 0.5rem
  DEFAULT: 1rem
  md: 1.5rem
  lg: 2rem
  xl: 3rem
  full: 9999px
spacing:
  base: 8px
  xs: 4px
  sm: 12px
  md: 24px
  lg: 48px
  xl: 80px
  container-max: 1200px
  gutter: 24px
---

## Brand & Style
This design system shifts away from color-driven identity toward a disciplined, high-contrast monochrome aesthetic. The brand personality is authoritative, precise, and uncompromisingly minimal, targeting high-end developer tools, executive dashboards, or premium creative portfolios.

The design style is **Ultra-Minimalist** with a focus on **Tonal Layering**. By utilizing a pure charcoal base and crisp white accents, the UI creates a "void-like" depth where content is the only priority. This aesthetic relies on perfect typography and intentional whitespace rather than decorative elements to convey quality and professional rigor.

## Colors
The palette is strictly achromatic to eliminate visual noise and focus the user's attention.

- **Primary (#FFFFFF):** Reserved exclusively for primary call-to-actions, active states, and critical information. It should "pop" against the dark background.
- **Surface/Neutral (#0A0A0A):** The foundation of the UI. This pure charcoal black provides the high-contrast base for all elements.
- **Muted/Secondary (#333333):** Used for borders, inactive input states, and secondary container backgrounds.
- **Tertiary (#777777):** Used for low-priority metadata, captions, and placeholder text.

Avoid all blue, indigo, or warm undertones. Grays must be neutral or slightly cool-balanced to maintain the "Charcoal" feel.

## Typography
The design system utilizes **JetBrains Mono** across all levels to reinforce a technical, precise, and developer-friendly character.

> **Implementation note:** The shipped app uses **Geist Mono** (bundled via the `geist` npm package) in place of JetBrains Mono. Geist Mono is a near-identical monospace with the same metrics and feel, and using it avoids an extra webfont network fetch. The `--font-jetbrains` CSS variable in `globals.css` is kept as an alias that resolves to Geist Mono for forward compatibility — if a future revision wants to swap in JetBrains Mono, only the variable needs to change. All sizing, weight, and letter-spacing guidance below applies equally to either font.

The monospaced nature of the font requires generous line height (1.6 for body text) to ensure readability in long-form content. Display styles should use tighter tracking and heavier weights to create a "blocky" high-fashion editorial feel. Labels and small captions should leverage uppercase styling with increased letter spacing to maximize legibility against the dark background.

## Layout & Spacing
The layout follows a **Fixed Grid** philosophy on desktop to maintain a controlled, architectural feel. 

- **Desktop:** 12-column grid, 1200px max-width, center-aligned. Gutters are fixed at 24px to provide clear breathing room between technical data points.
- **Tablet:** 8-column grid with 32px side margins.
- **Mobile:** 4-column grid with 20px side margins.

Spacing follows a strict 8px power-of-two scale. Negative space is used aggressively to separate functional groups rather than using lines or borders whenever possible.

## Elevation & Depth
In this design system, depth is achieved through **Tonal Layering** and **Subtle Outlines** rather than traditional shadows.

1. **Base Layer (#0A0A0A):** The main canvas.
2. **Elevated Surface (#121212):** Used for cards and modals, distinguished from the base by a 1px solid border of `#333333`.
3. **Overlay Layer (#1A1A1A):** Used for tooltips and floating menus.

Avoid drop shadows entirely. If an element needs to feel "above" the interface, use a thin, high-contrast white border (1px) to define its silhouette against the void.

## Shapes
Despite the technical typography, the shape language is **Ultra-Rounded (Pill-shaped)**. This creates a distinctive tension between the rigid monospaced text and the fluid, organic containers.

- **Buttons & Chips:** Use a full-radius (pill) shape.
- **Cards & Inputs:** Use a 1.5rem (24px) radius to maintain the soft-tech aesthetic.
- **Selection States:** Use rounded-full wrappers for indicators.

## Components
- **Buttons:** Primary buttons are solid white (#FFFFFF) with black text. Secondary buttons are outlined in #333333 with white text. Hover states for primary buttons should slightly reduce opacity (90%).
- **Inputs:** Backgrounds are #121212 with a #333333 border. Focus state moves the border to #FFFFFF. Use JetBrains Mono for all user input.
- **Chips:** Small, pill-shaped badges with #333333 backgrounds and #777777 text. Active chips flip to #FFFFFF background with #0A0A0A text.
- **Lists:** Separated by thin 1px horizontal rules in #333333. Use high-contrast white for list titles and tertiary gray for descriptions.
- **Cards:** No shadows. Use a background of #121212 and a border of #333333. Large 24px padding is mandatory.
- **Checkboxes/Radios:** When active, these should be solid White circles/squares with no internal iconography (minimalist check).