module.exports = {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Montserrat', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        brand: {
          slate: {
            950: '#0a0a0f',
            900: '#0f172a',
            800: '#1e293b',
          },
          blue: {
            500: '#3b82f6',
            400: '#60a5fa',
          },
          emerald: {
            500: '#10b981',
            400: '#34d399',
          },
        },
      },
    },
  },
  plugins: [],
}
