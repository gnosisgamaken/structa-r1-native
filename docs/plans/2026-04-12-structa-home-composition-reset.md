# structa home composition reset memo

this memo is intentionally blunt.

the current home screen is trying to do too many things at once on a screen that cannot support it. the result is overlap, wasted height, weak hierarchy, and a non-native feel.

## what home should be

home should be only three things:
- a very tight top identity row
- the card stack
- a tiny one-line audit preview

nothing else belongs there.

## remove from home

remove these from the default home scene:
- project summary block under the cards
- helper hint text on cards
- verbose log affordances
- visible save-33 button
- any mixed state/detail copy that belongs inside now or know

## what the four cards should feel like

### show
- image power
- icon-first
- no subtitle on home
- opens full-screen camera on hardware trigger

### tell
- voice power
- icon-first
- no subtitle on home
- opens full-screen listening state on hardware trigger

### know
- reasoning power
- icon-first
- no subtitle on home
- opens a focused insight surface

### now
- project power
- icon-first
- no subtitle on home
- opens a focused catch-up surface

## composition rules

### top zone
- the system bar is not ours
- place `structa` directly below it
- no floating title in the upper third
- no fake back arrow

### card zone
- selected card owns the center
- side cards show shape and icon, not full text blocks
- side cards should suggest browsing, not compete for reading attention
- selected card can be larger, but only if surrounding content becomes quieter

### bottom zone
- one single audit line on home
- no large log button
- no heavy footer chrome
- full audit opens only on explicit action

## hierarchy rules

- selected card: readable
- side cards: atmospheric, not informational
- home audit: glance only
- detail lives inside opened surfaces, never behind the main card

## anti-patterns to avoid

- text visible on multiple card layers at once
- a selected card that blocks important background text
- helper phrases like `tap for insight`, `ptt to capture`, `hold ptt`
- summary dashboards squeezed under navigation cards
- debug-looking log bars
- browser-history back behavior disguised as native navigation

## the right feeling

home should feel like:
- powers waiting
- not explanations waiting

when the user opens a card, then the app can explain through the surface itself.

## success snapshot

if the next home screen is right, a device photo should show:
- almost no wasted space above the app name
- one clean dominant card
- barely-there side cards
- no overlapping readable text from background cards
- one discreet bottom audit line
- no visible fake navigation chrome
- no visible save-33 pill dominating the screen
