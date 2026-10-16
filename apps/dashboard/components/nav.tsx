"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "סקירה", icon: "◧" },
  { href: "/alerts", label: "דורש התערבות", icon: "⚑" },
  { href: "/clients", label: "לקוחות", icon: "☺" },
  { href: "/knowledge", label: "בסיס הידע", icon: "✎" },
  { href: "/playground", label: "מגרש משחקים", icon: "▶" },
  { href: "/settings", label: "הגדרות", icon: "⚙" },
];

export function Nav({ openAlerts }: { openAlerts: number }) {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
      {ITEMS.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active ? "bg-emerald-50 text-emerald-800" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <span aria-hidden className="w-4 text-center text-base leading-none">
              {item.icon}
            </span>
            <span>{item.label}</span>
            {item.href === "/alerts" && openAlerts > 0 && (
              <span className="ms-auto rounded-full bg-red-600 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">{openAlerts}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
