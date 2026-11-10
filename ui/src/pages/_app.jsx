// src/pages/_app.jsx
import { Source_Sans_3, JetBrains_Mono } from "next/font/google";
import "../styles/globals.css";
import { SessionProvider } from "../lib/context/SessionContext";

// Self-hosted by next/font at build time; globals.css maps them to
// Tailwind's font-sans / font-mono.
const sans = Source_Sans_3({ subsets: ["latin"], variable: "--font-source-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });

export default function App({ Component, pageProps }) {
  return (
    <div className={`${sans.variable} ${mono.variable} font-sans`}>
      <SessionProvider>
        <Component {...pageProps} />
      </SessionProvider>
    </div>
  );
}
