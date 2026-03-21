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
          900: '#2D1B4E',
          800: '#3A2563',
          700: '#4A2D7A',
          600: '#5E3D8F',
          500: '#7352A5',
          400: '#8B6BB8',
          300: '#A98FCE',
          200: '#C7B3E0',
          100: '#E0D4F0',
          50: '#F3EEFB',
        },
        heat: {
          1: '#F3EEFB',
          2: '#D8C4F0',
          3: '#B794E0',
          4: '#8B5CC6',
          5: '#6B3FA0',
          6: '#DC2626',
          7: '#991B1B',
        },
      },
    },
  },
  plugins: [],
};
export default config;
