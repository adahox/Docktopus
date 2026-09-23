/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Sora", "ui-sans-serif", "system-ui"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
      colors: {
        ink: "#102033",
        sea: "#0f766e",
        mist: "#f3f6fb",
        line: "#d5e0ec",
      },
      boxShadow: {
        card: "0 10px 30px rgba(16, 32, 51, 0.06)",
      },
    },
  },
  plugins: [],
};
