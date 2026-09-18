# Timed actions and latency

## What the server knows

A request tells the server when it arrived, not when the player acted. On a
phone the gap is the network round trip, tens to hundreds of milliseconds,
and it varies tap to tap. In the sandbox there is no network, so
`npm run check` and the agent's own play never show it.

So a mechanic that judges a single tap by the server's clock at arrival is a
mechanic that judges the player's connection. A moving target that must be
released in a 115 ms window, evaluated at arrival, is a make on Wi-Fi and a
miss on a cell network for the same tap.

## Patterns, with what each costs

1. **Make the decisive input something other than a moment.** A choice, an
   answer, a path, a sequence, a turn. Timing then bounds the round, not the
   action: the server checks that the action arrived inside the round's window
   and validates its content. A word game works this way: the server validates
   tile paths and words; the clock only ends the round. Costs nothing in
   fairness and is the default for a money game.

2. **Client-timed actions on a server-issued clock.** The server puts the
   round's start time in the document; the client sends each action with its
   own elapsed time since that start; the server accepts an action when its
   elapsed time lies inside the round window, is later than the previous
   action's, and the request arrived no later than the claimed moment plus a
   tolerance for the trip, a couple of seconds at most. The server evaluates
   the action at the claimed moment. Cost: a client can shade its claim by up
   to the tolerance, so this suits small stakes or mechanics where a few
   hundred milliseconds do not decide the outcome.

3. **Deterministic replay.** The server seeds the round. The client plays the
   whole round locally and submits its input trace with timestamps. The server
   re-simulates the round from the seed and the trace with the same rules
   module the client used, applying the checks of pattern 2 to the trace. The
   result is what the server computed, never what the client reported. Cost:
   the game's rules must be deterministic and importable on both sides, and
   the trace must be small enough to send.

4. **Score by amounts, not moments.** Count how many, how far, how accurate
   over a fixed number of attempts whose windows are generous enough that the
   trip cannot flip them. The server still evaluates on arrival, but a tap
   cannot be late enough to matter.

## Where to look

- The round's start time and window live on the round document; the p2p mode
  keeps the start deadline and no-show window in `entry` and leaves the
  round's own clock to the game (see [p2p](./p2p.md), "What the game supplies").
- Whatever pattern you pick, the server owns the outcome: it never trusts a
  score, only inputs it can check.
