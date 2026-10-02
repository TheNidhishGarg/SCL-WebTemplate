import { strToU8, zipSync } from "fflate";

// Test-only archives.
// Two realistic fixtures, built in memory: a captured static site (what a
// SaveMyResources-style capture looks like) and a Next.js repository.

export const GOOGLE_KEY = "AIza" + "SyA1234567890abcdefghijklmnopqrstuv";
const header = `<header class="site-header"><nav class="main-nav"><a href="/">Home</a><a href="/about.html">About</a><a href="/contact">Contact</a></nav></header>`;
const footer = `<footer class="site-footer"><p>© Studio</p></footer>`;
const page = (title: string, body: string, lang = ' lang="en"') => `<!doctype html>
<html${lang}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/css/site.css">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
</head>
<body>
${header}
<main>
${body}
</main>
${footer}
</body>
</html>`;

export const staticSite = () =>
  zipSync({
    "studio/index.html": strToU8(
      page(
        "Studio",
        `<section class="hero dark"><h1>Hello</h1><img src="/images/hero.jpg"><img src="/images/missing.png" alt="x"></section>
<section class="work"><h2>Work</h2><h4>Skipped level</h4><form><input type="email" name="e"></form>
<a href="https://instagram.com/x" target="_blank">Insta</a><img src="http://insecure.example/pic.jpg" alt=""></section>
<script>gsap.to(".hero", { y: 10 }); eval("1+1");</script>`,
      ),
    ),
    "studio/about.html": strToU8(page("About", `<section class="hero dark"><h1>About</h1></section><section class="team"><h2>Team</h2></section>`, "")),
    "studio/css/site.css": strToU8(`:root { --brand: #0a84ff; --space-2: 0.5rem; }
/* a comment with #ffffff that is not a colour */
@font-face { font-family: "Inter"; font-weight: 400; src: url("../fonts/inter.woff2") format("woff2"); }
body { font-family: "Inter", sans-serif; color: #111; background: rgb(250, 250, 250); }
.hero { background: url(../images/hero.jpg); transition: opacity .3s; }
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
@media (min-width: 768px) { .work { columns: 2 } }
@media (min-width: 64em) { .work { columns: 3 } }`),
    "studio/js/app.js": strToU8(`const key = "${GOOGLE_KEY}";\nconsole.log(key);\n`),
    "studio/fonts/inter.woff2": new Uint8Array([1, 2, 3]),
    "studio/images/hero.jpg": new Uint8Array([255, 216, 255]),
  });

export const nextRepo = () =>
  zipSync({
    "package.json": strToU8(JSON.stringify({ name: "site", license: "MIT", dependencies: { next: "15.1.0", react: "19.0.0", gsap: "^3.12.0" } })),
    "package-lock.json": strToU8("{}"),
    "LICENSE": strToU8("MIT License\n\nPermission is hereby granted, free of charge, to any person..."),
    "next.config.ts": strToU8("export default {};"),
    "app/layout.tsx": strToU8(`import Header from "@/components/Header";\nexport default function RootLayout({ children }) { return <html lang="en"><body><Header />{children}</body></html>; }`),
    "app/page.tsx": strToU8(`import Card from "../components/Card";\nexport default function Home() { return <Card />; }`),
    "app/(marketing)/about/page.tsx": strToU8(`import Header from "../../../components/Header";\nexport default function About() { return <Header />; }`),
    "app/blog/[slug]/page.tsx": strToU8(`export default function Post() { return null; }`),
    "components/Header.tsx": strToU8(`import { gsap } from "gsap";\nimport "./header.css";\nexport default function Header() { return <nav />; }`),
    "components/header.css": strToU8(`.nav { transition: transform .2s } @media (prefers-reduced-motion: reduce) { .nav { transition: none } }`),
    "components/Card.tsx": strToU8(`export function Card() { return <div />; }`),
    ".env.local": strToU8("STRIPE=sk_live_abcdefghijklmnopqrstuvwx\n"),
    "node_modules/gsap/index.js": strToU8("module.exports = {}"),
  });

