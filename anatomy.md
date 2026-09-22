# App layout anatomy

A starting point for laying out a Bankroll game.

Home → Playing → Game result → Home.

```text
Home                        Results
┌─────────────────────┐     ┌─────────────────────┐
│ ?           Balance │     │ ?           Balance │
│                     │     │                     │
│    Game preview     │     │    Game history     │
│    Play options     │     │                     │
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

**Home.** Make a compelling visual of the game the focal point: its court,
board, scene, or a recognizable preview of play. Players should see what they
will be playing at a glance. Show clear choices, such as modes or dollar
amounts, above one primary **Play** button. Keep labels short and remove
superfluous text; longer instructions belong behind `?`. Home fits the
viewport with the tabs below it and does not scroll, on a 360-wide phone as
much as a tall one. Landing-page headlines and marketing copy belong on the
lander at `/`. A home tab that overflows is reported as a console error in
development, which fails `npm run check`.

**Results.** Show the player's game history. Each entry opens that game's result.
History is the tab that scrolls (`scroll: true`); settings, if any, may too.

**Playing.** This is the app's most important screen. Give it the largest share
of design, implementation, and playtesting attention: the scene, responsive
controls, readable game state, and feedback for each action. Play opens a
full-bleed game that reaches all four edges of the viewport, without tabs,
balance, or `?`. The game scene fills the screen; keep essential HUD elements
and touch controls clear of the notch and home indicator. Primary gameplay
fits on one screen without vertical or horizontal scrolling, including on
shorter phones.

**Game result.** When the game ends, open its result screen. Show the outcome
when available, or a waiting state while a match is being made. A clear **Home**
button takes the player home.

Keep text and controls inside the phone's safe area. Full-bleed gameplay
scenes and backgrounds extend underneath those insets to the screen edges.

**Text and labels.** Assume most copy goes unread. Extra labels and explanations
are visual noise. Keep necessary action labels and immediate feedback; use
visuals to teach. Longer explanations belong in help.
