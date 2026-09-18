# App layout anatomy

A starting point for laying out a Bankroll game.

Home → Playing → Game result → Home.

```text
Home                        Results
┌─────────────────────┐     ┌─────────────────────┐
│ ?           Balance │     │ ?           Balance │
│                     │     │                     │
│    Play options     │     │    Game history     │
│                     │     │                     │
│       [Play]        │     │                     │
│                     │     │                     │
├─────────────────────┤     ├─────────────────────┤
│ [Play]    Results   │     │ Play    [Results]   │
└─────────────────────┘     └─────────────────────┘

Playing                     Game result
┌─────────────────────┐     ┌─────────────────────┐
│                     │     │                     │
│                     │     │                     │
│      Play area      │     │       Outcome       │
│                     │     │     or waiting      │
│                     │     │                     │
│                     │     │       [Home]        │
│                     │     │                     │
└─────────────────────┘     └─────────────────────┘
```

**Header and tabs.** Home and Results show `?` at the top left and the Bankroll
balance at the top right, with cash and credits combined. The `?` opens
graphical instructions. The header does not need an app title or username.
Footer tabs **Play** and **Results** switch between home and history. They have
icons with text labels and stay visible while history scrolls.
[TabbedScreen](./src/components/tabbed-screen.tsx) supplies this layout.

**Home.** Put play options above the **Play** button. These might be modes or
dollar amounts when playing for money. Home fits the viewport with the tabs
below it and does not scroll, on a 360-wide phone as much as a tall one: the
game and its one action, no landing-page headline or marketing copy (the
lander at `/` is for that). A home tab that overflows is reported as a console
error in development, which fails `npm run check`.

**Results.** Show the player's game history. Each entry opens that game's result.
History is the tab that scrolls (`scroll: true`); settings, if any, may too.

**Playing.** Play opens the game full screen, without tabs, balance, or `?`.
Primary gameplay fits on one screen without vertical or horizontal scrolling,
including on shorter phones.

**Game result.** When the game ends, open its result screen. Show the outcome
when available, or a waiting state while a match is being made. A clear **Home**
button takes the player home.

Keep every screen's content inside the phone's safe area.

**Text and labels.** Assume most copy goes unread. Extra labels and explanations
are visual noise. Keep necessary action labels and immediate feedback; use
visuals to teach. Longer explanations belong in help.
