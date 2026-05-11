import "./globals.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { LangProvider } from "@/lib/i18n";
import { HeaderShell } from "@/components/header-shell";
import { ScoringConfigInit } from "@/components/scoring-config-init";

// Inter — screen-optimized sans with even letter spacing. Self-hosted at
// build time by next/font (no runtime fetch from Google), display:swap so
// the body never blanks on cold load. Variable axis covers all weights.
const inter = Inter({
  subsets: ["latin", "cyrillic"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Drop Sherlock",
  description: "AI-assisted domain backlink analysis powered by Ahrefs",
};

const preInitScript = `
(function () {
  // Errors here mean localStorage / matchMedia is blocked (sandboxed
  // iframe, strict cookie policy, etc.). The app still works with
  // defaults (light mode, English) — but we log so a user reporting
  // "wrong theme" has something we can see.
  try {
    var saved = localStorage.getItem('theme');
    var dark = saved === 'dark'
      || (saved === null && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {
    console.error('[drop-sherlock] theme pre-init failed:', e);
  }
  try {
    var lang = localStorage.getItem('lang');
    if (lang !== 'en' && lang !== 'ru') lang = 'en';
    document.documentElement.lang = lang;
  } catch (e) {
    console.error('[drop-sherlock] lang pre-init failed:', e);
  }
})();
`.trim();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: preInitScript }} />
      </head>
      <body>
        <LangProvider>
          <ScoringConfigInit />
          <HeaderShell />
          <main className="max-w-screen-2xl mx-auto px-6 py-8">{children}</main>
        </LangProvider>
      </body>
    </html>
  );
}
