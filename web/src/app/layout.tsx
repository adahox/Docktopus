import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Docktopus",
  description: "Topologia de ambientes Docker",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Sora:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
