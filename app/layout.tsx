import type { Metadata, Viewport } from "next";
import { Gloock, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

// Gloock's chiselled, high-contrast serif echoes inscriptions on monuments;
// Schibsted Grotesk keeps long reading passages plain and sturdy.
const display = Gloock({
  variable: "--font-display",
  weight: "400",
  subsets: ["latin", "latin-ext"],
});

const body = Schibsted_Grotesk({
  variable: "--font-body",
  subsets: ["latin", "latin-ext"],
});

export const metadata: Metadata = {
  title: "Welcome to Timor-Leste",
  description:
    "Fly to Dili and climb Cape Fatucama to Cristo Rei at sunrise: a 3D journey through the history, land and culture of Timor-Leste.",
};

export const viewport: Viewport = {
  themeColor: "#0c2a33",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // is-intro is in the server HTML so scrolling is locked from the first paint,
    // not only once the intro script has loaded; without JavaScript, the noscript
    // rules unlock the page and hide the intro overlay so the content stays readable.
    <html lang="en" className={`${display.variable} ${body.variable} is-intro`}>
      <body>
        <noscript>
          <style>{"html.is-intro, html.is-intro body { overflow: auto; } .splash { display: none; }"}</style>
        </noscript>
        {children}
      </body>
    </html>
  );
}
