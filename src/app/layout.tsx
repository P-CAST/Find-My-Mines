"use client";

import "~/styles/globals.css";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Geist } from "next/font/google";

import { TRPCReactProvider } from "~/trpc/react";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  const close = () => {
    setOpen(false);
    // Restore focus after React removes inert from the page.
    requestAnimationFrame(() => trigger.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    // Wait for DaisyUI to make the drawer visible before moving focus.
    const frame = requestAnimationFrame(() => {
      drawer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <html lang="en" data-theme="corporate" className={`${geist.variable}`}>
      <head>
        <title>Find My Mines</title>
        <meta
          name="description"
          content="A two-player race to find 11 bombs."
        />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>
        <TRPCReactProvider>
          <div className="drawer text-base-content">
            <input
              type="checkbox"
              className="drawer-toggle"
              checked={open}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
            />
            <div className="drawer-content" inert={open}>
              <header className="navbar bg-base-100 h-16 w-full">
                <div className="flex-1">
                  <button
                    ref={trigger}
                    type="button"
                    className="btn btn-square btn-ghost"
                    aria-label="Open navigation"
                    aria-controls="site-drawer"
                    aria-expanded={open}
                    onClick={() => setOpen(true)}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      className="h-6 w-6 stroke-current"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M4 6h16M4 12h16M4 18h16"
                      />
                    </svg>
                  </button>
                </div>
                <Link
                  href="/"
                  className="text-xl font-bold focus-visible:outline-2 sm:text-2xl"
                >
                  Find My Mines
                </Link>
                <div className="flex-1" />
              </header>
              {children}
            </div>
            <div
              id="site-drawer"
              ref={drawer}
              className="drawer-side z-30 transition-none"
              role="dialog"
              aria-label="Site navigation"
              aria-modal={open || undefined}
              inert={!open}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                }
                if (event.key === "Tab") {
                  const controls =
                    drawer.current?.querySelectorAll<HTMLElement>(
                      "button, a[href]",
                    );
                  const first = controls?.[0];
                  const last = controls?.[controls.length - 1];
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                  } else if (
                    !event.shiftKey &&
                    document.activeElement === last
                  ) {
                    event.preventDefault();
                    first?.focus();
                  }
                }
              }}
            >
              <div
                className="drawer-overlay"
                aria-hidden="true"
                onClick={close}
              />
              <nav
                className="bg-base-100 min-h-full w-80 max-w-[85vw] p-4"
                aria-label="Main"
              >
                <div className="mb-4 flex items-center justify-between gap-2">
                  <span className="text-lg font-bold">Find My Mines</span>
                  <button
                    type="button"
                    className="btn btn-square btn-ghost"
                    aria-label="Close navigation"
                    onClick={close}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      className="h-6 w-6 stroke-current"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="m6 6 12 12M6 18 18 6"
                      />
                    </svg>
                  </button>
                </div>
                <ul className="menu w-full p-0">
                  {[
                    { href: "/", label: "Home" },
                    { href: "/game", label: "Play" },
                    { href: "/operator", label: "Operator" },
                  ].map(({ href, label }) => (
                    <li key={href}>
                      <Link
                        href={href}
                        aria-current={pathname === href ? "page" : undefined}
                        className={
                          pathname === href ? "menu-active" : undefined
                        }
                        onClick={close}
                      >
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          </div>
        </TRPCReactProvider>
      </body>
    </html>
  );
}
