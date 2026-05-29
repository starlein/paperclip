# HUD Command Center Phase 1: Design System Foundation + Layout Shell

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the OH MY COMPANY platform into a futuristic HUD Command Center aesthetic by replacing the design system foundation (colors, typography, animations) and restyling all layout shell components (sidebar, rail, breadcrumbs, cards, buttons, badges, inputs, dialogs).

**Architecture:** Pure CSS theme overhaul with zero new JS dependencies. All theme variables replaced in `index.css`, Google Fonts loaded via `<link preload>` in `index.html`, 8 CSS `@keyframes` animations added, and each shadcn/layout component updated with HUD-specific Tailwind classes. A single new React hook (`useBootAnimation`) triggers page-enter animations on route changes.

**Tech Stack:** Tailwind CSS v4, OKLch color space, CSS custom properties, CSS `@keyframes`, `clip-path`, container queries, Google Fonts (Orbitron, JetBrains Mono), React hooks.

**Spec:** `docs/superpowers/specs/2026-04-05-hud-command-center-ui-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `ui/index.html` | Modify | Add Google Fonts `<link preload>` tags |
| `ui/src/index.css` | Modify | Replace all CSS variables, add keyframes, utility classes, grid background, scrollbar/MDXEditor updates |
| `ui/src/hooks/useBootAnimation.ts` | Create | Hook to add/remove `.hud-boot` class on route changes |
| `ui/src/context/ThemeContext.tsx` | Modify | Default theme to `"dark"` |
| `ui/src/components/ui/button.tsx` | Modify | HUD button variants (glow, Orbitron, sharp radius) |
| `ui/src/components/ui/badge.tsx` | Modify | Status color variants, glow-pulse support |
| `ui/src/components/ui/card.tsx` | Modify | `hud-panel` class option for clip-path + scan line |
| `ui/src/components/ui/input.tsx` | Modify | Electric blue focus glow |
| `ui/src/components/ui/dialog.tsx` | Modify | HUD overlay + panel styling |
| `ui/src/components/Layout.tsx` | Modify | Grid background, boot-in animation wrapper |
| `ui/src/components/CompanyRail.tsx` | Modify | Left accent line, selected glow |
| `ui/src/components/Sidebar.tsx` | Modify | HUD nav styling, section headers |
| `ui/src/components/SidebarSection.tsx` | Modify | Orbitron/JetBrains Mono headers, horizontal rules |
| `ui/src/components/SidebarNavItem.tsx` | Modify | Active glow, left border bar, Orbitron text |
| `ui/src/components/SidebarAgents.tsx` | Modify | Status dot glow-pulse, HUD typography |
| `ui/src/components/SidebarProjects.tsx` | Modify | HUD styling for project items |
| `ui/src/components/InstanceSidebar.tsx` | Modify | HUD styling matching main sidebar |
| `ui/src/components/BreadcrumbBar.tsx` | Modify | Mono separators, Orbitron current page |

---

## Chunk 1: Design System Foundation (CSS Variables, Fonts, Animations)

### Task 1: Add Google Fonts preload to index.html

**Files:**
- Modify: `ui/index.html:10` (after apple meta tags, before title)

- [ ] **Step 1: Add font preload link tags**

In `ui/index.html`, add after line 10 (the apple meta tags) and before the `<title>` tag:

```html
<link rel="preload" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"></noscript>
```

- [ ] **Step 2: Verify fonts load**

Run: `cd ui && npx vite --host 0.0.0.0 &`
Open browser DevTools > Network > filter "fonts.googleapis". Confirm the font CSS loads without blocking render.

- [ ] **Step 3: Commit**

```bash
git add ui/index.html
git commit -m "feat(hud): add Google Fonts preload for Orbitron and JetBrains Mono"
```

---

### Task 2: Replace CSS color variables with HUD dark palette

**Files:**
- Modify: `ui/src/index.css:6-115` (theme variable sections)

- [ ] **Step 1: Update `@theme inline` radius tokens (lines 39-42)**

The `@theme inline` block (lines 6-43) maps CSS variables to Tailwind v4 utility classes. Update the radius tokens so `rounded-sm`, `rounded-md`, etc. use the new sharp HUD values:

```css
  --radius-sm: 2px;
  --radius-md: 3px;
  --radius-lg: 4px;
  --radius-xl: 6px;
```

- [ ] **Step 2: Replace the `:root` theme variables (lines 45-80)**

Replace the existing `:root` block (lines 45-80, currently light-theme values) with the HUD dark palette. The original light values are removed — the light theme is deferred to Phase 4. Replace the `.dark` block (lines 82-115) with identical HUD values.

```css
:root {
  /* HUD Command Center — Dark-first palette (OKLch) */
  color-scheme: dark;
  --background: oklch(0.09 0.01 240);
  --foreground: oklch(0.93 0.01 240);
  --card: oklch(0.12 0.015 240);
  --card-foreground: oklch(0.93 0.01 240);
  --popover: oklch(0.14 0.015 240);
  --popover-foreground: oklch(0.93 0.01 240);
  --primary: oklch(0.72 0.15 220);
  --primary-foreground: oklch(0.09 0.01 240);
  --secondary: oklch(0.16 0.02 240);
  --secondary-foreground: oklch(0.88 0.01 240);
  --muted: oklch(0.18 0.015 240);
  --muted-foreground: oklch(0.55 0.02 240);
  --accent: oklch(0.16 0.02 240);
  --accent-foreground: oklch(0.93 0.01 240);
  --destructive: oklch(0.65 0.25 25);
  --destructive-foreground: oklch(0.98 0 0);
  --border: oklch(0.22 0.025 240);
  --input: oklch(0.22 0.025 240);
  --ring: oklch(0.72 0.15 220);
  --radius: 2px;

  /* Semantic status colors */
  --status-active: oklch(0.75 0.18 155);
  --status-warning: oklch(0.78 0.15 75);
  --status-error: oklch(0.65 0.25 25);
  --status-info: oklch(0.72 0.15 220);
  --status-violet: oklch(0.65 0.2 290);

  /* Chart colors */
  --chart-1: oklch(0.72 0.15 220);
  --chart-2: oklch(0.75 0.18 155);
  --chart-3: oklch(0.78 0.15 75);
  --chart-4: oklch(0.65 0.2 290);
  --chart-5: oklch(0.65 0.25 25);

  /* Sidebar tokens */
  --sidebar: oklch(0.10 0.015 240);
  --sidebar-foreground: oklch(0.88 0.01 240);
  --sidebar-primary: oklch(0.72 0.15 220);
  --sidebar-primary-foreground: oklch(0.09 0.01 240);
  --sidebar-accent: oklch(0.14 0.02 240);
  --sidebar-accent-foreground: oklch(0.93 0.01 240);
  --sidebar-border: oklch(0.20 0.02 240);
  --sidebar-ring: oklch(0.72 0.15 220);

  /* Font families */
  --font-display: 'Orbitron', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --font-sans: 'Inter', system-ui, sans-serif;

  /* Radius tokens */
  --radius-sm: 2px;
  --radius-md: 3px;
  --radius-lg: 4px;
  --radius-xl: 6px;
}
```

- [ ] **Step 3: Update the `.dark` selector block (lines 82-115)**

Replace the entire `.dark { }` block so it mirrors the `:root` values (since HUD is dark-first, both are identical). This ensures toggling `.dark` class has no visual jump:

```css
.dark {
  color-scheme: dark;
  --background: oklch(0.09 0.01 240);
  --foreground: oklch(0.93 0.01 240);
  --card: oklch(0.12 0.015 240);
  --card-foreground: oklch(0.93 0.01 240);
  --popover: oklch(0.14 0.015 240);
  --popover-foreground: oklch(0.93 0.01 240);
  --primary: oklch(0.72 0.15 220);
  --primary-foreground: oklch(0.09 0.01 240);
  --secondary: oklch(0.16 0.02 240);
  --secondary-foreground: oklch(0.88 0.01 240);
  --muted: oklch(0.18 0.015 240);
  --muted-foreground: oklch(0.55 0.02 240);
  --accent: oklch(0.16 0.02 240);
  --accent-foreground: oklch(0.93 0.01 240);
  --destructive: oklch(0.65 0.25 25);
  --destructive-foreground: oklch(0.98 0 0);
  --border: oklch(0.22 0.025 240);
  --input: oklch(0.22 0.025 240);
  --ring: oklch(0.72 0.15 220);
  --chart-1: oklch(0.72 0.15 220);
  --chart-2: oklch(0.75 0.18 155);
  --chart-3: oklch(0.78 0.15 75);
  --chart-4: oklch(0.65 0.2 290);
  --chart-5: oklch(0.65 0.25 25);
  --sidebar: oklch(0.10 0.015 240);
  --sidebar-foreground: oklch(0.88 0.01 240);
  --sidebar-primary: oklch(0.72 0.15 220);
  --sidebar-primary-foreground: oklch(0.09 0.01 240);
  --sidebar-accent: oklch(0.14 0.02 240);
  --sidebar-accent-foreground: oklch(0.93 0.01 240);
  --sidebar-border: oklch(0.20 0.02 240);
  --sidebar-ring: oklch(0.72 0.15 220);
}
```

- [ ] **Step 4: Update scrollbar colors (lines 167-204)**

Replace the hardcoded gray scrollbar colors with HUD palette values. **Important:** keep the `.dark *::` selector pattern (with `*` descendant combinator) to match all scrollable children:

```css
.dark *::-webkit-scrollbar-track {
  background: oklch(0.12 0.015 240); /* matches --card */
}

.dark *::-webkit-scrollbar-thumb {
  background: oklch(0.30 0.02 240);
  border-radius: 4px;
}

.dark *::-webkit-scrollbar-thumb:hover {
  background: oklch(0.72 0.15 220); /* matches --primary */
}
```

Also update the `.scrollbar-auto-hide` hover variants (lines 196-204):

```css
.scrollbar-auto-hide:hover::-webkit-scrollbar-track {
  background: oklch(0.12 0.015 240) !important;
}
.scrollbar-auto-hide:hover::-webkit-scrollbar-thumb {
  background: oklch(0.30 0.02 240) !important;
}
.scrollbar-auto-hide:hover::-webkit-scrollbar-thumb:hover {
  background: oklch(0.72 0.15 220) !important;
}
```

- [ ] **Step 5: Verify the app renders with new colors**

Run the dev server and verify the app background is deep navy-black (#0a0e1a), text is cool white, and borders are visible but subtle.

- [ ] **Step 6: Commit**

```bash
git add ui/src/index.css
git commit -m "feat(hud): replace all CSS color variables with HUD dark palette"
```

---

### Task 3: Add CSS keyframe animations

**Files:**
- Modify: `ui/src/index.css` (append after the activity-row keyframes around line 251)

- [ ] **Step 1: Add all 8 HUD keyframe animations**

Append after the existing `@keyframes activity-row-enter` block (around line 251):

```css
/* ===== HUD COMMAND CENTER ANIMATIONS ===== */

/* 4.1 Scan Line — sweeps down panels */
@keyframes hud-scan {
  0% { transform: translateY(0); opacity: 0; }
  5% { opacity: 1; }
  95% { opacity: 1; }
  100% { transform: translateY(100cqh); opacity: 0; }
}

/* 4.2 Border Trace — electric blue glow traces panel edge on hover */
@keyframes border-trace {
  0% { background-position: 0% 0%; }
  100% { background-position: 200% 0%; }
}

/* 4.3 Glow Pulse — status indicators breathe */
@keyframes glow-pulse {
  0%, 100% { box-shadow: 0 0 4px var(--glow-color, oklch(0.72 0.15 220)); }
  50% { box-shadow: 0 0 12px var(--glow-color, oklch(0.72 0.15 220)), 0 0 24px var(--glow-color, oklch(0.72 0.15 220)); }
}

/* 4.4 Data Reveal — blur-to-sharp transition */
@keyframes data-reveal {
  0% { opacity: 0; filter: blur(4px); transform: translateY(4px); }
  100% { opacity: 1; filter: blur(0); transform: translateY(0); }
}

/* 4.5 Boot Sequence — page entrance */
@keyframes boot-in {
  0% { opacity: 0; transform: translateY(8px); filter: blur(2px); }
  40% { opacity: 0.7; filter: blur(0); }
  100% { opacity: 1; transform: translateY(0); }
}

/* 4.6 Radar Sweep — radial sweep on circular widgets */
@keyframes radar-sweep {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* 4.7 Background Grid Pulse — tactical grid breathes */
@keyframes grid-fade {
  0%, 100% { opacity: 0.03; }
  50% { opacity: 0.07; }
}

/* 4.8 Holographic Shimmer — diagonal light sweep */
@keyframes holo-shimmer {
  0% { transform: translateX(-100%) rotate(-45deg); }
  100% { transform: translateX(200%) rotate(-45deg); }
}
```

- [ ] **Step 2: Add HUD utility classes**

Append after the keyframes:

```css
/* ===== HUD UTILITY CLASSES ===== */

/* Font utilities */
.font-display { font-family: var(--font-display); }
.font-mono { font-family: var(--font-mono); }

/* Boot-in animation (triggered by useBootAnimation hook) */
.hud-boot {
  animation: boot-in 500ms cubic-bezier(0.16, 1, 0.3, 1) both;
  will-change: filter, transform, opacity;
}

/* Data reveal container — children stagger in */
.data-reveal > * {
  animation: data-reveal 300ms cubic-bezier(0.16, 1, 0.3, 1) both;
  will-change: filter, transform, opacity;
}
.data-reveal > :nth-child(1) { animation-delay: 0ms; }
.data-reveal > :nth-child(2) { animation-delay: 50ms; }
.data-reveal > :nth-child(3) { animation-delay: 100ms; }
.data-reveal > :nth-child(4) { animation-delay: 150ms; }
.data-reveal > :nth-child(5) { animation-delay: 200ms; }
.data-reveal > :nth-child(6) { animation-delay: 250ms; }
.data-reveal > :nth-child(7) { animation-delay: 300ms; }
.data-reveal > :nth-child(8) { animation-delay: 350ms; }
.data-reveal > :nth-child(9) { animation-delay: 400ms; }
.data-reveal > :nth-child(10) { animation-delay: 450ms; }

/* Section header with decorative // prefix */
.hud-section-header {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.hud-section-header::before {
  content: "// ";
  color: var(--muted-foreground);
}

/* HUD Panel — clip-path tactical corners */
.hud-panel {
  position: relative;
  container-type: size;
}

/* Scan line pseudo-element on panels */
.hud-panel::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--primary);
  opacity: 0.15;
  animation: hud-scan 8s linear infinite;
  will-change: transform, opacity;
  pointer-events: none;
  z-index: 1;
}

/* Inner wrapper gets the clip-path (so pseudo-elements on outer are not clipped) */
.hud-panel-inner {
  clip-path: polygon(
    0 0,
    calc(100% - 12px) 0,
    100% 12px,
    100% 100%,
    12px 100%,
    0 calc(100% - 12px)
  );
}

/* Border trace on hover */
.hud-border-trace {
  position: relative;
}
.hud-border-trace::before {
  content: "";
  position: absolute;
  inset: 0;
  border: 1px solid transparent;
  background: linear-gradient(90deg, transparent 0%, var(--primary) 50%, transparent 100%) border-box;
  background-size: 200% 100%;
  mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  opacity: 0;
  transition: opacity 200ms;
  pointer-events: none;
  z-index: 2;
}
.hud-border-trace:hover::before {
  opacity: 1;
  animation: border-trace 2s linear infinite;
}

/* Holographic shimmer on hover */
.hud-shimmer {
  position: relative;
  overflow: hidden;
}
.hud-shimmer::after {
  content: "";
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: linear-gradient(
    to right,
    transparent 0%,
    rgba(255, 255, 255, 0.03) 45%,
    rgba(255, 255, 255, 0.05) 50%,
    rgba(255, 255, 255, 0.03) 55%,
    transparent 100%
  );
  pointer-events: none;
  z-index: 1;
  transform: translateX(-100%) rotate(-45deg);
}
.hud-shimmer:hover::after {
  animation: holo-shimmer 1.5s ease-in-out;
}

/* Glow pulse for status indicators */
.hud-glow {
  animation: glow-pulse 2s ease-in-out infinite;
  --glow-color: var(--primary);
}
.hud-glow-fast {
  animation: glow-pulse 1.5s ease-in-out infinite;
  --glow-color: var(--status-error);
}
.hud-glow-success {
  animation: glow-pulse 2s ease-in-out infinite;
  --glow-color: var(--status-active);
}

/* Background tactical grid */
.hud-grid-bg::before {
  content: "";
  position: fixed;
  inset: 0;
  background-image:
    repeating-linear-gradient(0deg, var(--border) 0 1px, transparent 1px 60px),
    repeating-linear-gradient(90deg, var(--border) 0 1px, transparent 1px 60px);
  animation: grid-fade 6s ease-in-out infinite;
  pointer-events: none;
  z-index: 0;
}

/* Accessibility: respect reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* Mobile: reduce animation intensity */
@media (max-width: 768px) {
  .hud-glow,
  .hud-glow-fast,
  .hud-glow-success {
    animation: none;
  }
  .hud-shimmer:hover::after {
    animation: none;
  }
  .hud-panel::after {
    animation-duration: 16s;
  }
}
```

- [ ] **Step 3: Update MDXEditor code block background**

The MDXEditor theme integration starts at line 253 of `index.css`. The `.paperclip-mdxeditor-scope` block maps variables like `--baseBase`, `--baseBg`, etc. These already reference CSS variables (e.g., `var(--background)`) so they will automatically pick up the new HUD colors. However, check for any hardcoded Catppuccin colors (e.g., `#1e1e2e`, `#181825`) in the `.paperclip-markdown` code block styles (lines 544+). Replace hardcoded dark backgrounds with `var(--secondary)` or `oklch(0.14 0.015 240)` to ensure sufficient contrast against the new `--card` background (`oklch(0.12 0.015 240)`).

- [ ] **Step 4: Verify animations work**

Open the browser, add class `hud-boot` to a div in DevTools, verify the boot-in animation plays. Add `hud-glow` to a small element, verify it pulses.

- [ ] **Step 5: Commit**

```bash
git add ui/src/index.css
git commit -m "feat(hud): add 8 CSS keyframe animations and HUD utility classes"
```

---

### Task 4: Create useBootAnimation hook

**Files:**
- Create: `ui/src/hooks/useBootAnimation.ts`

- [ ] **Step 1: Create the hook file**

```typescript
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Adds `.hud-boot` class to the given element ref on route changes,
 * triggering the boot-in CSS animation. Removes the class after
 * the animation completes to allow re-triggering on next navigation.
 */
export function useBootAnimation<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const location = useLocation();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    el.classList.add("hud-boot");

    const handleEnd = () => {
      el.classList.remove("hud-boot");
    };

    el.addEventListener("animationend", handleEnd, { once: true });

    return () => {
      el.removeEventListener("animationend", handleEnd);
      el.classList.remove("hud-boot");
    };
  }, [location.pathname]);

  return ref;
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/hooks/useBootAnimation.ts
git commit -m "feat(hud): add useBootAnimation hook for route-change page transitions"
```

---

### Task 5: Default theme to dark and update meta theme-color

**Files:**
- Modify: `ui/src/context/ThemeContext.tsx:20`
- Modify: `ui/index.html:6,22`

- [ ] **Step 1: Update DARK_THEME_COLOR constant**

In `ThemeContext.tsx`, line 20, change the dark theme color to the HUD navy:

```typescript
const DARK_THEME_COLOR = "#0a0e1a";  // HUD deep navy-black (was #18181b)
```

The `resolveThemeFromDocument()` function (line 24-27) already returns `"dark"` when the document has the `.dark` class, and `index.html` starts with `class="dark"`, so the default is already dark. No change needed there.

- [ ] **Step 2: Update index.html meta theme-color and inline script**

In `ui/index.html`, update the meta tag (line 6):

```html
<meta name="theme-color" content="#0a0e1a" />
```

And update the inline script dark color constant (line 22):

```javascript
const darkThemeColor = "#0a0e1a";
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/context/ThemeContext.tsx ui/index.html
git commit -m "feat(hud): update meta theme-color to HUD navy-black (#0a0e1a)"
```

---

## Chunk 2: Component Transformations (UI Primitives)

### Task 6: Restyle Button component

**Files:**
- Modify: `ui/src/components/ui/button.tsx:7-39`

- [ ] **Step 1: Update buttonVariants base classes**

Replace the base string (line 8) with HUD styling:

```typescript
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[2px] text-[11px] font-semibold font-[var(--font-display)] uppercase tracking-[0.04em] transition-[color,background-color,border-color,box-shadow,opacity] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
```

- [ ] **Step 2: Update variant classes (variant only, NOT size)**

Replace only the `variant` object inside `variants`. Keep the existing `size` variants unchanged:

```typescript
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-[0_0_20px_var(--primary)]",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 hover:shadow-[0_0_16px_var(--destructive)] dark:bg-destructive/60",
        outline:
          "border border-primary bg-transparent text-foreground shadow-xs hover:bg-accent hud-border-trace",
        secondary:
          "bg-secondary text-secondary-foreground hover:border-border/80 hover:bg-secondary/80",
        ghost:
          "hover:bg-primary/8 hover:text-accent-foreground dark:hover:bg-primary/8",
        link: "text-primary underline-offset-4 hover:underline",
      },
```

- [ ] **Step 3: Verify buttons render correctly**

Open browser, check that primary buttons glow on hover, outline buttons have border-trace animation, ghost buttons have a subtle blue tint on hover.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/ui/button.tsx
git commit -m "feat(hud): restyle buttons with Orbitron font, glow effects, sharp radius"
```

---

### Task 7: Restyle Badge component

**Files:**
- Modify: `ui/src/components/ui/badge.tsx:7-27`

- [ ] **Step 1: Update badgeVariants**

Replace the base and variant classes:

```typescript
const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-[2px] border border-transparent px-2 py-0.5 text-[10px] font-medium font-[var(--font-mono)] uppercase tracking-[0.05em] w-fit whitespace-nowrap shrink-0 gap-1 transition-[color,box-shadow] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        default:
          "bg-primary/15 text-primary border-primary/20 [a&]:hover:bg-primary/25",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive/15 text-destructive border-destructive/20 [a&]:hover:bg-destructive/25",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent",
        ghost:
          "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link:
          "text-primary underline-offset-4 [a&]:hover:underline",
        /* HUD status variants */
        active:
          "bg-[var(--status-active)]/15 text-[var(--status-active)] border-[var(--status-active)]/20",
        warning:
          "bg-[var(--status-warning)]/15 text-[var(--status-warning)] border-[var(--status-warning)]/20",
        error:
          "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/20",
        info:
          "bg-[var(--status-info)]/15 text-[var(--status-info)] border-[var(--status-info)]/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
```

- [ ] **Step 2: Update the BadgeProps type**

Make sure the `variant` type in `BadgeProps` includes the new status variants by updating the `VariantProps<typeof badgeVariants>` — this happens automatically from CVA.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/ui/badge.tsx
git commit -m "feat(hud): restyle badges with JetBrains Mono, status color variants"
```

---

### Task 8: Restyle Card component

**Files:**
- Modify: `ui/src/components/ui/card.tsx:5-16`

- [ ] **Step 1: Update Card base classes**

Replace the Card className (line 10):

```typescript
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "bg-card text-card-foreground flex flex-col gap-6 rounded-[2px] border border-border py-6 shadow-sm hud-panel hud-shimmer hud-border-trace",
        className,
      )}
      {...props}
    />
  );
}
```

- [ ] **Step 2: Update CardHeader to use HUD section header style**

Replace the CardTitle className (around line 35):

```typescript
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-[var(--font-display)] text-[12px] font-semibold uppercase tracking-[0.06em] leading-none", className)}
      {...props}
    />
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/ui/card.tsx
git commit -m "feat(hud): restyle cards with clip-path panels, scan line, shimmer"
```

---

### Task 9: Restyle Input component

**Files:**
- Modify: `ui/src/components/ui/input.tsx:11-13`

- [ ] **Step 1: Update input focus styling**

Replace the className (lines 11-14):

```typescript
className={cn(
  "file:text-foreground placeholder:text-muted-foreground placeholder:font-[var(--font-mono)] placeholder:text-[12px] placeholder:italic selection:bg-primary selection:text-primary-foreground bg-secondary border-input h-9 w-full min-w-0 rounded-[2px] border px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:shadow-[0_0_8px_var(--primary)/30%] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive disabled:pointer-events-none disabled:opacity-50 md:text-sm",
  "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
  className,
)}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/ui/input.tsx
git commit -m "feat(hud): restyle inputs with electric blue focus glow, mono placeholders"
```

---

### Task 10: Restyle Dialog component

**Files:**
- Modify: `ui/src/components/ui/dialog.tsx:39-41,61-62`

- [ ] **Step 1: Update DialogOverlay**

Replace overlay className (lines 39-41):

```typescript
className={cn(
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/70 backdrop-blur-sm duration-100",
  className,
)}
```

- [ ] **Step 2: Update DialogContent**

Replace content className (lines 61-62) — add rounded-[2px], hud-panel-like styling:

```typescript
className={cn(
  "bg-card text-card-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.97] data-[state=open]:zoom-in-[0.97] data-[state=closed]:slide-out-to-top-[1%] data-[state=open]:slide-in-from-top-[1%] fixed top-[max(1rem,env(safe-area-inset-top))] md:top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-0 md:translate-y-[-50%] gap-4 rounded-[2px] border border-border p-6 shadow-lg duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
  className,
)}
```

- [ ] **Step 3: Update DialogTitle**

Replace title className (around line 125):

```typescript
className={cn("font-[var(--font-display)] text-sm font-semibold uppercase tracking-[0.06em]", className)}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/ui/dialog.tsx
git commit -m "feat(hud): restyle dialogs with HUD overlay, Orbitron titles, sharp corners"
```

---

## Chunk 3: Layout Shell Components

### Task 11: Update Layout with grid background and boot animation

**Files:**
- Modify: `ui/src/components/Layout.tsx:1-36,261-270,414`

- [ ] **Step 1: Import useBootAnimation**

Add to the imports (around line 1-36):

```typescript
import { useBootAnimation } from "../hooks/useBootAnimation";
```

- [ ] **Step 2: Use the hook in the component**

Inside the `Layout` component function body (around line 49-50), add:

```typescript
const bootRef = useBootAnimation<HTMLDivElement>();
```

- [ ] **Step 3: Add grid background class to outermost div**

Find the outermost container div (around line 262):

```typescript
<div className={cn(
  "bg-background text-foreground hud-grid-bg pt-[env(safe-area-inset-top)]",
```

- [ ] **Step 4: Attach bootRef to main content area**

Find the main content `<main>` or content div (around line 414) and add the ref:

```typescript
<div
  ref={bootRef}
  className={cn(
    "flex-1 p-4 md:p-6",
```

- [ ] **Step 5: Verify grid background and boot animation**

Open browser. Verify subtle grid lines behind content. Navigate between pages — content should fade/slide in with a 500ms boot animation.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/Layout.tsx
git commit -m "feat(hud): add tactical grid background and boot-in page transitions"
```

---

### Task 12: Restyle CompanyRail

**Files:**
- Modify: `ui/src/components/CompanyRail.tsx:126-133,141-146,332`

- [ ] **Step 1: Add left accent line to rail container**

Find the rail container div (line 332):

```typescript
"flex flex-col items-center w-[72px] shrink-0 h-full bg-[var(--sidebar)] border-r border-[var(--sidebar-border)] border-l-2 border-l-[var(--primary)]"
```

- [ ] **Step 2: Update selection indicator**

Find the selection indicator (lines 126-133). Change `bg-foreground` to `bg-[var(--primary)]`:

```typescript
className={cn(
  "absolute left-[-14px] w-1 rounded-r-full bg-[var(--primary)] transition-[height] duration-150",
  isSelected ? "h-5" : "h-0 group-hover:h-2",
)}
```

- [ ] **Step 3: Add glow to selected company icon**

Find the company icon wrapper (lines 141-146). Add a glow ring when selected:

```typescript
className={cn(
  "relative overflow-visible transition-transform duration-150",
  isSelected
    ? "rounded-[14px] ring-2 ring-[var(--primary)] shadow-[0_0_12px_var(--primary)]"
    : "rounded-[22px] group-hover:rounded-[14px]",
)}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/CompanyRail.tsx
git commit -m "feat(hud): restyle CompanyRail with left accent line and selected glow"
```

---

### Task 13: Restyle Sidebar

**Files:**
- Modify: `ui/src/components/Sidebar.tsx:60,62-80`

- [ ] **Step 1: Update sidebar container background**

Replace the container className (line 60):

```typescript
"w-60 h-full min-h-0 border-r border-[var(--sidebar-border)] bg-[var(--sidebar)] flex flex-col"
```

- [ ] **Step 2: Update company name to use Orbitron**

Find the company name display (around line 70-72). Add HUD font:

```typescript
className="text-sm font-bold truncate font-[var(--font-display)] uppercase tracking-[0.04em]"
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/Sidebar.tsx
git commit -m "feat(hud): restyle sidebar with HUD background and Orbitron headers"
```

---

### Task 14: Restyle SidebarSection

**Files:**
- Modify: `ui/src/components/SidebarSection.tsx:11`

- [ ] **Step 1: Update section header styling**

Replace the header className (line 11):

```typescript
"px-3 py-1.5 text-[9px] font-medium uppercase tracking-[0.08em] font-[var(--font-mono)] text-muted-foreground/60 border-b border-border/30 mb-1"
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/SidebarSection.tsx
git commit -m "feat(hud): restyle sidebar section headers with mono font and rule"
```

---

### Task 15: Restyle SidebarNavItem

**Files:**
- Modify: `ui/src/components/SidebarNavItem.tsx:41-46,50-55`

- [ ] **Step 1: Update NavLink classes**

Replace the NavLink className (lines 41-46):

```typescript
className={({ isActive }) =>
  cn(
    "flex items-center gap-2.5 px-3 py-2 text-[11px] font-semibold font-[var(--font-display)] uppercase tracking-[0.06em] transition-colors rounded-[2px]",
    isActive
      ? "bg-[var(--sidebar-accent)] text-foreground border-l-2 border-l-[var(--primary)]"
      : "text-foreground/80 hover:bg-[var(--sidebar-accent)]/50 hover:text-foreground",
  )
}
```

- [ ] **Step 2: Add glow to active icon**

Find the icon rendering (around line 50-55). Add conditional glow class:

When `isActive`, wrap the icon with a subtle glow. In the icon `className`:

```typescript
<item.icon className={cn("h-4 w-4", isActive && "text-[var(--primary)] drop-shadow-[0_0_4px_var(--primary)]")} />
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/SidebarNavItem.tsx
git commit -m "feat(hud): restyle nav items with Orbitron, active glow, left border bar"
```

---

### Task 16: Restyle SidebarAgents

**Files:**
- Modify: `ui/src/components/SidebarAgents.tsx:75-86,111-116,120-137`

- [ ] **Step 1: Update section header styling**

Find the section label (around line 82-84):

```typescript
className="text-[9px] font-medium uppercase tracking-[0.08em] font-[var(--font-mono)] text-muted-foreground/60"
```

- [ ] **Step 2: Update agent NavLink classes**

Replace the agent NavLink className (lines 111-116):

```typescript
className={
  activeAgentId === agentRouteRef
    ? "flex items-center gap-2.5 px-3 py-1.5 text-[11px] font-semibold font-[var(--font-display)] uppercase tracking-[0.04em] transition-colors bg-[var(--sidebar-accent)] text-foreground rounded-[2px]"
    : "flex items-center gap-2.5 px-3 py-1.5 text-[11px] font-medium font-[var(--font-display)] uppercase tracking-[0.04em] transition-colors text-foreground/80 hover:bg-[var(--sidebar-accent)]/50 hover:text-foreground rounded-[2px]"
}
```

- [ ] **Step 3: Add glow-pulse to live agent indicator**

Find the animated pulse indicator (around lines 120-137). Add `hud-glow` class to the live dot:

```typescript
<span className="relative flex h-2 w-2">
  <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--status-info)] hud-glow" />
</span>
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/SidebarAgents.tsx
git commit -m "feat(hud): restyle agent list with Orbitron, live glow-pulse indicators"
```

---

### Task 17: Restyle SidebarProjects

**Files:**
- Modify: `ui/src/components/SidebarProjects.tsx:80-85`

- [ ] **Step 1: Update project NavLink classes**

Replace the project item className (lines 80-85):

```typescript
className={cn(
  "flex items-center gap-2.5 px-3 py-1.5 text-[11px] font-medium font-[var(--font-display)] uppercase tracking-[0.04em] transition-colors rounded-[2px]",
  activeProjectRef
    ? "bg-[var(--sidebar-accent)] text-foreground"
    : "text-foreground/80 hover:bg-[var(--sidebar-accent)]/50 hover:text-foreground",
)}
```

- [ ] **Step 2: Update section header styling**

Find the section label in the collapsible trigger. Update to match HUD mono style:

```typescript
className="text-[9px] font-medium uppercase tracking-[0.08em] font-[var(--font-mono)] text-muted-foreground/60"
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/SidebarProjects.tsx
git commit -m "feat(hud): restyle project list with Orbitron items, mono section header"
```

---

### Task 18: Restyle InstanceSidebar

**Files:**
- Modify: `ui/src/components/InstanceSidebar.tsx:15-20`

- [ ] **Step 1: Update container and header**

Replace the sidebar container className (line 15):

```typescript
"w-60 h-full min-h-0 border-r border-[var(--sidebar-border)] bg-[var(--sidebar)] flex flex-col"
```

Replace the title className (around line 19):

```typescript
"flex-1 text-sm font-bold text-foreground truncate font-[var(--font-display)] uppercase tracking-[0.04em]"
```

- [ ] **Step 2: Update plugin sub-item links**

Find the plugin NavLink classes (around lines 31-48). Update:

```typescript
className={({ isActive }) =>
  cn(
    "rounded-[2px] px-2 py-1.5 text-[10px] font-medium font-[var(--font-mono)] uppercase tracking-[0.04em] transition-colors",
    isActive
      ? "bg-[var(--sidebar-accent)] text-foreground"
      : "text-muted-foreground hover:bg-[var(--sidebar-accent)]/50 hover:text-foreground",
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/InstanceSidebar.tsx
git commit -m "feat(hud): restyle InstanceSidebar with HUD theme tokens"
```

---

### Task 19: Restyle BreadcrumbBar

**Files:**
- Modify: `ui/src/components/BreadcrumbBar.tsx:50,74-76`

- [ ] **Step 1: Update container**

Replace the container className (line 50):

```typescript
"border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center justify-end bg-transparent"
```

- [ ] **Step 2: Update title display**

Replace the h1 className (lines 74-76):

```typescript
className="text-[13px] font-semibold font-[var(--font-display)] uppercase tracking-[0.08em] truncate"
```

- [ ] **Step 3: Update breadcrumb separator**

If there's a separator component or character, replace with `>` in JetBrains Mono. Look for `BreadcrumbSeparator` usage and ensure:

```typescript
<BreadcrumbSeparator className="font-[var(--font-mono)] text-muted-foreground">&gt;</BreadcrumbSeparator>
```

- [ ] **Step 4: Update breadcrumb link/page styling**

For parent links:
```typescript
className="text-[12px] text-muted-foreground hover:text-[var(--primary)] transition-colors"
```

For current page:
```typescript
className="text-[11px] font-[var(--font-display)] uppercase tracking-[0.06em] truncate"
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/BreadcrumbBar.tsx
git commit -m "feat(hud): restyle breadcrumbs with Orbitron current page, mono separators"
```

---

### Task 20: Final visual verification and cleanup

- [ ] **Step 1: Full visual walkthrough**

Open the app and navigate through:
1. Login → Dashboard (verify boot-in animation)
2. Sidebar navigation (verify Orbitron text, active glow, border bars)
3. Company rail (verify left accent line, selected glow)
4. Create a new issue (verify card styling, input focus glow)
5. Open a dialog (verify dark overlay, sharp corners, Orbitron title)
6. Check breadcrumbs (verify mono separators, Orbitron current)
7. Resize to mobile (verify animations are reduced)
8. Open DevTools → Performance → verify no layout thrashing from animations

- [ ] **Step 2: Fix any visual inconsistencies found during walkthrough**

Address any issues found (font not loading, animation glitches, color mismatches).

- [ ] **Step 3: Final commit**

```bash
git add ui/
git commit -m "feat(hud): Phase 1 complete — HUD Command Center design system and layout shell"
```

---

## Deferred to Phase 2-4

- **Tables (spec 5.9):** Table-heavy pages (Issues, Members) will get HUD table styling in Phase 4 when those pages are individually redesigned. The CSS variables and font utilities added in Phase 1 will automatically improve table contrast.
- **Toasts (spec 5.11):** Toast components will be restyled in Phase 4.

---

## Execution Notes

- **No tests for CSS changes:** This is a visual-only refactor with no logic changes. Testing is visual verification via browser.
- **Incremental commits:** Each task produces a working commit. If any task introduces a visual bug, it can be reverted independently.
- **Fonts may flash:** Until Google Fonts load, text will use system fonts (Inter already available). The `display=swap` strategy prevents invisible text.
- **Existing light theme:** The `:root` block is replaced with HUD dark values. The light theme is deferred to Phase 4 — toggling to light mode will show the dark palette until Phase 4 adds proper light values.
