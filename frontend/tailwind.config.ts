import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Cool slate-tinted dark surfaces, ported from the AI Anchor Generator
        // palette so the dark theme feels softer than pure-black neutral.
        // Only the deep shades (700–950) are remapped — shades 50–500 (used in
        // light mode) keep Tailwind's default neutral values.
        neutral: {
          700: "#262d36",
          800: "#1b2026",
          900: "#14181d",
          950: "#0b0d10",
        },
      },
    },
  },
  plugins: [],
};
export default config;
