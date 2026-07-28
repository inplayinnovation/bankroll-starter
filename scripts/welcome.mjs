// create-bankroll-app runs `npm install` right after downloading this template,
// so npm's postinstall hook is the one moment we can greet someone who has never
// seen the project before — and point them at the command that actually gets
// the app onto a phone.
//
// It stays quiet where a banner would just be noise in a log: CI and Vercel
// builds print nothing, and colour is only emitted to a real terminal.
const isCI = Boolean(process.env.CI || process.env.VERCEL);
if (isCI) process.exit(0);

const NARROW_TERMINAL_COLUMNS = 72;
const color = process.stdout.isTTY ? (code, text) => `\x1b[${code}m${text}\x1b[0m` : (_, text) => text;

// emerald-400 — the accent the app itself uses.
const accent = (text) => color('38;2;52;211;153', text);
const bold = (text) => color('1', text);
const dim = (text) => color('2', text);

const WORDMARK = String.raw`
 ██████╗  █████╗ ███╗   ██╗██╗  ██╗██████╗  ██████╗ ██╗     ██╗
 ██╔══██╗██╔══██╗████╗  ██║██║ ██╔╝██╔══██╗██╔═══██╗██║     ██║
 ██████╔╝███████║██╔██╗ ██║█████╔╝ ██████╔╝██║   ██║██║     ██║
 ██╔══██╗██╔══██║██║╚██╗██║██╔═██╗ ██╔══██╗██║   ██║██║     ██║
 ██████╔╝██║  ██║██║ ╚████║██║  ██╗██║  ██║╚██████╔╝███████╗███████╗
 ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝
`;

const fitsWordmark = (process.stdout.columns ?? NARROW_TERMINAL_COLUMNS) >= NARROW_TERMINAL_COLUMNS;

console.log(accent(fitsWordmark ? WORDMARK : '\n  BANKROLL\n'));
console.log(`  ${bold('A real-money app.')} It takes payments and pays money back out.\n`);
console.log(`  ${accent('npm run bankroll')}  ${dim('dev server + tunnel, then scan the QR to open it in Bankroll')}`);
console.log(`  ${dim('npm run dev')}       ${dim('just the dev server')}\n`);
console.log(`  ${dim('Not configured yet? Ask your agent: "Set up this Bankroll app."')}\n`);
