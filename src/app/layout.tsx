import type { Metadata, Viewport } from "next";
import {
  Inter,
  JetBrains_Mono,
  Orbitron,
  Rajdhani,
  Share_Tech_Mono,
} from "next/font/google";
import { StargateProvider } from "@/lib/stargate-context";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import "./globals.css";

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["600", "700"],
});

const rajdhani = Rajdhani({
  variable: "--font-rajdhani",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400"],
});

const shareTech = Share_Tech_Mono({
  variable: "--font-share-tech",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "STARGATE — STARRA",
  description: "Personal ops command deck for a single operator.",
  applicationName: "STARGATE",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "STARGATE",
  },
  icons: {
    icon: "/brand/badge.png",
    apple: "/brand/badge.png",
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0a0414",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${orbitron.variable} ${rajdhani.variable} ${jetbrains.variable} ${inter.variable} ${shareTech.variable} min-h-dvh bg-[var(--void)] antialiased`}
      >
        <StargateProvider>
          <ServiceWorkerRegister />
          {children}
        </StargateProvider>
      </body>
    </html>
  );
}
