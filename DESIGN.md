---
name: Ventify Mobile
description: Clear, branded workspace for everyday retail operations.
colors:
  neutral-paper: "#F5F7FB"
  surface-white: "#FFFFFF"
  surface-muted: "#F0F3F9"
  ink-navy: "#17243D"
  text-secondary: "#596981"
  text-muted: "#65748B"
  border-soft: "#DFE6F0"
  brand-blue: "#315BE8"
  brand-blue-soft: "#EAF0FF"
  brand-violet: "#7545D9"
  brand-violet-soft: "#F1ECFC"
  success: "#087F5B"
  success-soft: "#E8F6EF"
  warning: "#A65E09"
  warning-soft: "#FFF4DE"
  danger: "#BF3545"
  danger-soft: "#FFF0F1"
  on-primary: "#FFFFFF"
typography:
  display:
    fontFamily: "System"
    fontSize: "28px"
    fontWeight: 700
  section:
    fontFamily: "System"
    fontSize: "18px"
    fontWeight: 700
  body:
    fontFamily: "System"
    fontSize: "16px"
    fontWeight: 400
  label:
    fontFamily: "System"
    fontSize: "13px"
    fontWeight: 600
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "20px"
  pill: "9999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
  xxxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.brand-blue}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    height: "48px"
  card:
    backgroundColor: "{colors.surface-white}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.md}"
  filter-chip-selected:
    backgroundColor: "{colors.brand-blue-soft}"
    textColor: "{colors.brand-blue}"
    rounded: "{rounded.pill}"
---

# Design System: Ventify Mobile

## Overview

**Creative North Star: “El espacio de trabajo Ventify”**

Ventify Mobile is a calm, recognizable workspace for retail tasks. Its light surfaces keep product, money, and status information easy to scan; the original Ventify cart-and-growth mark carries identity, while blue marks the next action and violet gives secondary information a distinct place. The visual language stays practical and native to a phone or tablet rather than turning operational screens into marketing pages.

Composition follows the task: a clear screen title and useful context, a small number of grouped sections, and a visible next action. Cards are for genuinely grouped information such as a product, cash shift, or customer details; a flat layout with headings is preferred for navigation and settings. Real data and Spanish labels remain the product content.

**Key Characteristics:**
- Light operational canvas, white content surfaces, navy text, and precise Ventify blue actions.
- Original logo asset and consistent brand shell across sign-in and operations.
- Compact, task-first hierarchy that adapts from a bottom phone navigation to a left tablet rail.
- Status color carries meaning; it does not replace the brand palette.

The review images in `.impeccable/review/` document the sign-in, sales, inventory, cash, settings, checkout, product form, and tablet POS compositions. They are Expo Web captures from an isolated copy with sample-data labeling (except the sign-in capture); they are references for composition and tokens, not proof of native-device behavior or real business data.

## Colors

The palette uses cool paper and white for working surfaces, deep navy for primary reading, and blue from the Ventify mark for action. Violet is a secondary accent; green, amber, and red are reserved for semantic states.

### Primary
- **Ventify action blue** (`brand-blue`): Primary actions, active navigation, selected controls, important totals, and focus emphasis.
- **Soft action blue** (`brand-blue-soft`): Selected navigation and filter backgrounds behind blue foregrounds.

### Secondary
- **Graph violet** (`brand-violet`): Secondary emphasis such as alternative financial metrics and supporting actions.
- **Soft violet** (`brand-violet-soft`): Low-emphasis backgrounds for violet labels and secondary status categories.

### Tertiary
- **Success green** (`success`, `success-soft`): Positive operational outcomes and healthy stock states only.
- **Caution amber** (`warning`, `warning-soft`): Pending, low-stock, and attention states.
- **Alert red** (`danger`, `danger-soft`): Errors, depleted stock, destructive actions, and negative financial states.

### Neutral
- **Cool paper** (`neutral-paper`): Default app workspace background.
- **White surface** (`surface-white`): Header, forms, cards, modals, and other foreground surfaces.
- **Muted surface** (`surface-muted`): Quiet input, inactive-control, and grouped-data backgrounds.
- **Navy ink** (`ink-navy`): Headings, primary body text, and monetary values.
- **Secondary ink** (`text-secondary`): Supporting copy, metadata, and inactive navigation.
- **Muted ink** (`text-muted`): Placeholder and low-priority metadata text.
- **Soft border** (`border-soft`): One-pixel separators and quiet card or input outlines.
- **On primary** (`on-primary`): Foreground on filled blue actions.

**The Semantic Color Rule.** Green, amber, and red communicate state; they are not alternate brand colors. Do not use the reserved dark palette for the general operational workspace; it remains available for camera and other specialized dark surfaces.

## Typography

**Display Font:** System native sans-serif.
**Body Font:** System native sans-serif.
**Label/Mono Font:** System labels; monospace appears only in code-like or measured values where the component calls for it.

**Character:** Compact, direct, and legible at arm’s length. The system uses native platform lettering rather than loading a custom display face; hierarchy comes from size, weight, and spacing.

### Hierarchy
- **Display** (700, 28 px): Screen titles and primary page identity.
- **Section** (700, 18 px): Section headings and card-level group titles.
- **Body** (400–600, 15–16 px): Instructions, product names, form values, and general content.
- **Label** (500–700, 11–13 px): Field labels, navigation captions, stock metadata, and compact controls.
- **Metric** (600–800, 17–24 px): Prices, totals, and key operational values; align and size for quick comparison.

**The Readable Numbers Rule.** Monetary values and quantities take visual priority over metadata. Keep full currency context where shown and do not replace live values with illustrative claims.

## Layout

The interface uses an adaptive single-workspace layout. On phones, content is vertically stacked with approximately 20 px screen gutters, compact horizontal filter rails, and a safe-area-aware bottom tab bar. At widths of 900 px and above, the tab layout moves to a 176 px left rail; the POS can use the remaining width for broad product rows and a persistent cart/checkout dock. Preserve the working width of text and controls rather than stretching each field across a tablet.

The spacing rhythm is 2, 4, 8, 12, 16, 20, 24, and 32 px. Use 20 px as the common screen inset, 12–16 px to group related fields and card content, and 24–32 px to separate major sections. Keep the top app shell distinct from page content: the real logo, branch context, and register status sit above the task; screen headings name the current task and provide short context.

The POS prioritizes product search and scanning, with secondary utilities grouped below and cart/checkout actions kept at the bottom. Inventory puts a compact valuation and stock summary before its navigation, search, filters, and product records. Cash, sales, and settings use explicit section headings and keep related information together. On tablets, navigation becomes a side rail and product records become horizontal rows rather than oversized phone cards.

## Elevation & Depth

The system is mostly flat. White surfaces and quiet borders define cards and fields; tonal backgrounds separate selected controls and grouped data. Use native elevation only where a floating sheet or persistent action needs separation. Avoid stacking a visible border with a strong shadow or applying the shadow scale to every card.

## Shapes

The form language uses gently rounded rectangles: the shared radius is 14 px, cards and major panels use roughly 12–16 px, inputs and controls 10–12 px, and compact badges use smaller corners. Filter chips and status badges may be pill-shaped because their compact, repeatable selection/state role benefits from that silhouette; keep larger cards and actions rectangular. Borders stay thin and low contrast, with no ornamental outlines.

## Components

### Brand and headings
- Use the original `assets/brand/ventify-logo.png` asset for the cart-and-rising-graph mark. Keep the written wordmark in navy with its brand-blue accent; do not substitute a generic icon or redraw the mark.
- `ScreenHeading` establishes a 28 px task title, one concise explanatory line, and an optional primary action. `SectionHeading` introduces real groups without an eyebrow or decorative numbering.

### Buttons
- **Shape:** Confident, gently rounded controls (10–12 px) with a minimum 48 px action height.
- **Primary:** Solid action blue with white foreground; reserve for the principal next step.
- **Secondary:** White or muted surface with a thin border, or soft blue with blue text for selected/contextual actions.
- **Disabled:** Reduce emphasis and prevent the control from competing with an available action; preserve readable labels.

### Chips
- **Style:** Compact category, status, and filter controls sit in a horizontal rail or wrap when needed.
- **State:** Selected filter chips use soft blue with blue text or a filled blue treatment where stronger contrast is needed; unselected chips use muted or white surfaces and secondary text. Filter pills are the intentional exception to the larger rectangular action shape.

### Cards / Containers
- **Corner style:** 12–16 px with a quiet border and white surface.
- **Internal spacing:** 12–16 px for product and operational records; keep the identity, main value/status, and secondary actions visually distinct.
- **Product record:** Name and identifier first, stock state beside the identity, sale price before cost/margin, and add/edit/stock actions after the commercial information.

### Inputs / Fields
- White field surface, navy value text, secondary placeholder, thin neutral border, and 10–12 px radius. Maintain a clear label above each field; group related fields under section headings and keep the primary save action in a fixed safe-area footer when the form is long.

### Navigation
- **Phone:** White bottom tab bar with icon and compact label; active destinations use blue ink and a soft-blue icon field. Respect bottom safe-area insets.
- **Tablet:** At 900 px and wider, use a fixed-width white left rail with beside-icon labels. Keep navigation selection treatment consistent with the phone.
- **App shell:** The white top header carries the original logo, branch, register status, and access/lock action.

### Sheets and dialogs
- Use white headers with a clear title and a 48 px close target, a light form surface, grouped fields, and a fixed footer that accounts for safe area. Keep camera preview dark only while scanning.

## Do's and Don'ts

### Do:
- **Do** use the shared `ui` roles from `src/lib/theme.ts` for operational surfaces and brand actions.
- **Do** pair the original logo with the established navy, blue, and violet identity.
- **Do** make product name, price, stock, and the next action scannable before secondary metadata.
- **Do** keep touch actions at least 48 px where the layout permits, and account for safe areas in fixed bars and sheets.
- **Do** retain the compact pill form for filter and state chips while keeping primary actions and cards rectangular.
- **Do** treat the listed PNG captures as Expo Web design references with sample data, not as native-emulator evidence.

### Don't:
- **Don't** turn the overall operational workspace dark or make green the dominant brand/action color.
- **Don't** replace the logo mark with an emoji, a generic store symbol, or an invented V.
- **Don't** use decorative gradients, glows, heavy shadows, or repeated cards as the only way to organize a screen.
- **Don't** invent sales, stock, savings, or performance claims in examples or empty states.
- **Don't** claim native-device verification from Expo Web captures.
