Your app's icon goes here: a square PNG, 256×256 or larger, named
`bankroll-icon.png`. Bankroll fetches it from
`/.well-known/bankroll-icon.png` and shows it on your app's tile — until you
serve one, it shows a monogram of your app's name.

(The manifest itself is a route, not a file here — see
`src/app/.well-known/bankroll.jwt/route.ts`.)
