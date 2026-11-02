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
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
