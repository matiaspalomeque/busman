/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        azure: {
          light: "#faf9f8",
          dark: "#1b1a19",
          secondary: "#323130",
          primary: "#0078d4",
          50: "#eff6ff",
          100: "#dbeafe",
          400: "#60a5fa",
          500: "#0078d4",
          600: "#006cbf",
          700: "#005fa3",
        },
      },
      animation: {
        'count-flash': 'count-flash 2s ease-out',
      },
      keyframes: {
        'count-flash': {
          '0%': { backgroundColor: 'rgba(0, 120, 212, 0.15)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
