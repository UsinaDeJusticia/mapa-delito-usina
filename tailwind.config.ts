import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        usina: {
          50:  '#E8EDF4',
          100: '#C5D1E4',
          200: '#9BB1CF',
          300: '#7191BA',
          400: '#4A71A5',
          500: '#1E427C',
          600: '#1A3A6D',
          700: '#15305B',
          800: '#102649',
          900: '#0B1C37',
        },
        gris: {
          marca: '#A7A8AC',
        },
        heat: {
          1: '#C5D1E4',
          2: '#9BB1CF',
          3: '#4A71A5',
          4: '#1E427C',
          5: '#15305B',
          6: '#B91C1C',
          7: '#991B1B',
        },
      },
    },
  },
  plugins: [],
};
export default config;
