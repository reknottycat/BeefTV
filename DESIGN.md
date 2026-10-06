---
version: alpha
name: "BeefTV Production Asset Catalog"
description: "Read-only production asset discovery using BeefTV's existing workspace visual system."
colors:
  primary: "#171717"
  on-primary: "#ffffff"
  card: "#f7f7f7"
  card-hover: "#f0f0f0"
  danger: "#dc2626"
  warning: "#d97706"
  success: "#16a34a"
  info: "#2563eb"
typography:
  sans:
    fontFamily: '"Inter Variable", "Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif'
  mono:
    fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
spacing:
  compact: "8px"
  field-gap: "12px"
  card-gap: "16px"
  section-gap: "24px"
components:
  workspace-page: {}
  asset-library-card: {}
  media-preview: {}
  pagination: {}
  button: {}
  select: {}
  search: {}
  quality-state: {}
---

# BeefTV Production Asset Catalog

This document records source evidence and the approved feature boundary. Visual
candidate selection, dependency installation, rendered comparison and browser
verification are pending. It does not claim that the catalog UI is implemented.

## Overview

The visual reference is the existing BeefTV asset library: quiet workspace chrome,
media-first cards and readable metadata. The catalog serves a Chinese-speaking
creator finding existing images, video versions, voice, storyboards and generation
evidence on a Windows workstation. It is a product tool with Chinese UI copy and
original source identifiers preserved verbatim. Mixed Chinese and English source
names do not establish a separate market requirement.

The signature is evidence beside media: a visible version and availability label,
with quality claims expanded in the detail view. Large decorative statistics,
cinematic animation and an unrelated brand palette would obscure this job.

## Colors and token ownership

Model B applies: the existing runtime tokens remain canonical. The frontmatter
mirrors the classic light skin; it is not a new generated palette. Dark skin
values continue to come from the existing adapters.

| Role | Canonical owner | Adapter / consumer |
| --- | --- | --- |
| Primary action pair | `web/src/styles/globals.css` `--btn-solid-bg`, `--btn-solid-fg` | `web/src/lib/app-theme.ts` `getAntThemeConfig`, shared Ant buttons |
| Card surfaces | `globals.css` `--card-surface`, `--card-surface-hover`, `--media-surface` | `AssetLibraryCard`, `AssetLibraryCardMedia` |
| Status roles | `globals.css` `--palette-status-*` | Existing theme status tokens; labels must carry meaning beyond color |
| Font stacks | `globals.css` `--font-sans`, `--font-mono` | Existing CSS utilities and theme adapter |
| Spacing and radii | `globals.css` `--space-*`, `--r-*` | Existing workspace/card classes and feature CSS using semantic variables |

No durable token change is proposed. Future changes must update the canonical
source once, its theme adapter and this mirror together. Static source comparisons
and browser computed styles are the drift evidence; neither has been substituted
with an invented export pipeline.

## Typography

Use the existing sans stack for Chinese labels and descriptive copy. Use the
existing mono stack for IDs, SHA, file paths and provider request IDs. Preserve
copyable full identifiers in detail views and allow long paths to wrap. Existing
body typography is 14px (`--fs-body`); page titles use the shared PageHeader.
Do not promote the upstream 7–11px canvas annotations into primary catalog text.
Dates and numbers use `zh-CN`, with the displayed timezone stated explicitly.

## Layout

Reuse `WorkspacePage`, `PageHeader`, `ListToolbar`, `CollectionGrid` and
`PaginationBar`. The existing collection uses one column at narrow widths and
auto-fill cards with a 248px minimum at wider widths. The detail route uses natural
document scrolling so long evidence is reachable. Media reserves its aspect ratio.
Loading and errors keep the result area's geometry stable.

The isolated catalog entry must own its document's visible scrollbar baseline;
it must not adopt upstream canvas/sidebar rules that hide scrollbars. This is a
feature-scoped integration requirement, not a redesign of unrelated BeefTV routes.

## Elevation and shapes

Use existing tonal card surfaces and radius tokens. Shared cards establish hover
and selected treatment. Evidence sections use quiet divisions, not repeated
floating panels or decorative shadows. Keep the original media aspect ratio;
never crop a shot in its detail preview merely to match the card shape.

## Components and behavior

The canonical component map for this feature is:

| Capability | Owner | Feature decision |
| --- | --- | --- |
| Workspace chrome | `components/layout/workspace-page.tsx` | Reuse shared layout and pagination |
| Asset card shell | `components/assets/asset-library-card.tsx` | Reuse shell; navigation is an anchor |
| Image/video preview | `components/media-preview.tsx` | Pass indexed same-origin media URLs; no resource-cache ingestion |
| Audio preview | Native `<audio controls>` | Indexed same-origin URL; accessible asset label |
| Theme | `lib/app-theme.ts`, `lib/skin-themes.ts`, `styles/globals.css` | Minimal ConfigProvider using existing classic theme |
| Search and select | Ant Input / Select | Chinese locale, explicit clear label, IME-safe search, cancellation |
| Async data | TanStack Query + `services/api/production-asset-index.ts` | GET only; keep readable stale results during refresh |
| Read errors | Feature inline state + existing Button | Retry, return to list; no native dialogs |
| Quality evidence | Catalog DTO `states` / `claims` | Render each dimension and conflicting source claims separately |

The entry must not mount the original workspace hydrator, ClientRootInit, canvas
bootstrap or builtin-plugin bootstrap. Those own other initialization and write
flows. The production catalog is a separate read-only route surface.

Search, kind, conflict filter, page and page size persist in URL parameters. A
filter change resets paging. Search debounces 300ms after IME composition ends;
clear and Enter are immediate. Every navigation uses links; every action uses a
button with visible focus. The layout includes loading, empty, no-results,
degraded-source, missing-media and fetch-failure states.

## Content and quality vocabulary

Use Chinese user-facing labels. Preserve raw source values in expandable evidence.
Generation, technical QA, visual review, user acceptance and availability are
separate dimensions. A manifest SHA is labeled “清单声明”; locally hashed content
is labeled “本地已验证”. Conflicting evidence is displayed with its source, not
resolved from filename or read order. Old rejected candidates retain rejection
on their exact versions. Missing links are labeled “尚无记录”.

## Motion and accessibility

Use existing state transitions only where they communicate a change; no decorative
entrance sequence. Respect reduced motion. Target WCAG 2.2 AA with semantic
landmarks, labeled controls, visible keyboard focus and readable status text.
Details and navigation remain usable at narrow widths and with long identifiers.
No destructive or generation controls belong to this first phase.

## Verification gate

Before the UI can be called usable: finish the authorized 12ui candidate workflow
without uploading private production material, run strict premium audit and the
relevant Bun checks, exercise the real Windows browser and same-origin Range
playback, and compare the catalog against the original BeefTV asset workflow.
Record actual outcomes and unresolved issues in the implementation handoff.

