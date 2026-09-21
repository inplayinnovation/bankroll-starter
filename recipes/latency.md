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
   tile paths and words; the clock only ends the round. Network delay still
   matters near the cutoff, but does not decide the value of every input.

2. **Client-timed actions on a server-issued clock.** The server puts the
   round's start time in the document; the client sends each action with its
   own elapsed time since that start; the server accepts an action when its
   elapsed time lies inside the round window, is later than the previous
   action's, and the request arrived no later than the claimed moment plus a
   tolerance for the trip, a couple of seconds at most. The server evaluates
   the action at the claimed moment. Cost: a client can fabricate timestamps
   within the accepted tolerance. A tolerance wider than the decisive scoring
   window lets a fabricated input change the result. This rule bounds accepted
   claims; it does not establish when a human tapped.

3. **Deterministic replay.** The server seeds the round. The client plays the
   whole round locally and submits its input trace with timestamps. The server
   re-simulates the round from the seed and the trace with the same rules
   module the client used. Validate input order, rate, mechanics, size and the
   allowed play window. Give the whole upload its own submission cutoff;
   early trace events cannot satisfy a per-action arrival tolerance when the
   trace arrives at the end of the round. The server computes the result.
   Cost: deterministic rules must work on both sides, and a fabricated perfect
   trace can still be legal. Replay verification is not proof of human input.

4. **Score by amounts, not moments.** Count how many, how far, how accurate
   over a fixed number of attempts whose windows are generous enough that
   ordinary network delay rarely changes them. The server still evaluates
   the received inputs and applies the declared cutoff.

## Where to look

- The [P2P engine](../engine/p2p/README.md) supplies `startedAt`, `endsAt`,
  `closesAt` and the effective event time in the game context. `durationMs`
  fixes the play window; `submissionGraceMs` adds time to upload inputs that
  were valid during play. A late timer does not extend either window.
- The [word example](../engine/p2p/examples/words.ts) validates streamed paths.
  The [shooting example](../engine/p2p/examples/shooting.ts) checks a bounded
  replay and recomputes trajectories, with a separate submission grace period.
- Whatever pattern you pick, the server owns the outcome: it never trusts a
  score, only inputs it can check.
